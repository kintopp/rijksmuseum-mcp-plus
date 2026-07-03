import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { RijksmuseumApiClient } from "../../api/RijksmuseumApiClient.js";
import { VocabularyDb, formatDimensions } from "../../api/VocabularyDb.js";
import { UsageStats } from "../../utils/UsageStats.js";
import {
  IIIF_REGION_RE,
  viewerQueues,
} from "../state.js";
import {
  parsePctRegion,
  cropPixelsToIiifPixels,
  oobError,
  checkRegionBounds,
  computeDeliveryState,
  projectToFullImage,
  type OobWarning,
} from "../geometry.js";
import {
  ARTWORK_VIEWER_RESOURCE_URI,
  ANN_READ_CLOSED,
  ANN_VIEWER,
  stripNullCoerceBool,
  optStr,
  type InferOutput,
  EMIT_STRUCTURED,
  structuredResponse,
  withOutputSchema,
  createLogger,
} from "../helpers.js";
import {
  ImageInfoOutput,
  InspectImageOutput,
} from "../outputSchemas.js";

export function registerViewerTools(
  server: McpServer,
  api: RijksmuseumApiClient,
  vocabDb: VocabularyDb | null,
  _publicBaseUrl: string | undefined,
  withLogging: ReturnType<typeof createLogger>,
  _stats?: UsageStats
): void {
  // ── get_artwork_image (MCP App with inline IIIF viewer) ────────

  // Single source of truth for the vocab-lookup + IIIF-resolve prelude shared by
  // get_artwork_image, remount_viewer, and inspect_artwork_image. Callers that
  // need viewer-payload shaping go through resolveArtworkImagePayload below;
  // inspect_artwork_image consumes the raw artwork + imageInfo for IIIF region
  // math.
  type ArtworkMetadata = NonNullable<ReturnType<VocabularyDb["lookupImageMetadata"]>>;
  type ImageInfo = NonNullable<Awaited<ReturnType<RijksmuseumApiClient["getImageInfoFast"]>>>;
  type ArtworkAndImage =
    | { ok: false; reason: "no_artwork" | "no_image"; error: string }
    | { ok: true; artwork: ArtworkMetadata; imageInfo: ImageInfo };

  const loadArtworkAndImageInfo = async (objectNumber: string): Promise<ArtworkAndImage> => {
    const artwork = vocabDb?.lookupImageMetadata(objectNumber);
    if (!artwork) return { ok: false, reason: "no_artwork", error: "No artwork found for this object number" };
    const imageInfo = artwork.iiifId ? await api.getImageInfoFast(artwork.iiifId) : null;
    if (!imageInfo) return { ok: false, reason: "no_image", error: "No image available for this artwork" };
    return { ok: true, artwork, imageInfo };
  };

  // Shape the ImageInfoOutput payload sans viewUUID. Callers add the UUID and
  // finalise the text-channel narration.
  type ArtworkImagePayload =
    | { ok: false; error: string }
    | {
        ok: true;
        data: Omit<InferOutput<typeof ImageInfoOutput>, "viewUUID">;
        width: number;
        height: number;
        narrationPrefix: string;
      };
  const resolveArtworkImagePayload = async (objectNumber: string): Promise<ArtworkImagePayload> => {
    const loaded = await loadArtworkAndImageInfo(objectNumber);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    const { artwork, imageInfo } = loaded;

    const physicalDimensions = formatDimensions(artwork.heightCm, artwork.widthCm);
    const { thumbnailUrl, iiifId, ...imageData } = imageInfo;
    const data: Omit<InferOutput<typeof ImageInfoOutput>, "viewUUID"> = {
      ...imageData,
      objectNumber: artwork.objectNumber,
      title: artwork.title,
      creator: artwork.creator,
      date: artwork.date,
      license: artwork.license,
      physicalDimensions,
      url: `https://www.rijksmuseum.nl/en/collection/${artwork.objectNumber}`,
    };
    const dims = data.width && data.height ? ` | ${data.width}×${data.height}px` : "";
    const licenseTag = artwork.license ? ` [${artwork.license}]` : "";
    const narrationPrefix = `${artwork.objectNumber} — "${artwork.title}" by ${artwork.creator}${dims}${licenseTag}`;
    return { ok: true, data, width: imageInfo.width, height: imageInfo.height, narrationPrefix };
  };

  registerAppTool(
    server,
    "get_artwork_image",
    {
      title: "Get Artwork Image",
      annotations: ANN_VIEWER,
      description:
        "Opens an interactive deep-zoom viewer for the user — only when they ask to see, show, or view an artwork. " +
        "Call ONLY when the user explicitly wants to see, show, or view an artwork. " +
        "Do NOT call for list, summary, count, or text-only requests. " +
        "Not for visual analysis by the LLM — use inspect_artwork_image to get image bytes. " +
        "Not all artworks have images available. " +
        "Returns metadata and a viewer link, not the image bytes themselves; do not construct or fetch IIIF image URLs manually (downloadable images are on rijksmuseum.nl).",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
      }).strict(),
      ...withOutputSchema(ImageInfoOutput),
      _meta: {
        ui: { resourceUri: ARTWORK_VIEWER_RESOURCE_URI },
      },
    },
    withLogging("get_artwork_image", async (args) => {
      const payload = await resolveArtworkImagePayload(args.objectNumber);
      if (!payload.ok) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: payload.error,
        };
        // Signal failure with isError so the agent treats it as such and the
        // viewer iframe surfaces the real reason ("No artwork found" / "No image
        // available") instead of a generic fallback. Mirrors remount_viewer and
        // inspect_artwork_image's no_artwork path.
        return { ...structuredResponse(errorData, payload.error), isError: true as const };
      }

      const viewUUID = randomUUID();
      viewerQueues.set(viewUUID, {
        commands: [],
        createdAt: Date.now(),
        lastAccess: Date.now(),
        objectNumber: payload.data.objectNumber,
        imageWidth: payload.width,
        imageHeight: payload.height,
      });

      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID };
      const text = `${payload.narrationPrefix} | viewUUID: ${viewUUID}`;
      return structuredResponse(viewerData, text);
    })
  );

  // ── remount_viewer (app-only, hidden from agent tools/list) ─────
  //
  // In-viewer related-artwork navigation calls this to swap the artwork
  // *without* minting a fresh viewUUID. Preserving the UUID keeps the
  // agent's stored navigate_viewer target valid across in-viewer
  // navigation (issue #310). Spec basis: SEP-1865 § "Resource Discovery
  // → Visibility" (visibility:["app"]) + § "Standard MCP Messages →
  // Tools" (tools/call from a View to an app-only tool).

  registerAppTool(
    server,
    "remount_viewer",
    {
      title: "Remount Viewer",
      annotations: ANN_VIEWER,
      description:
        "Internal: switch the viewer to a different artwork while preserving the viewUUID. " +
        "Called by the artwork-viewer iframe during in-viewer related navigation. " +
        "Any user highlight is cleared on remount because its coordinates belong to the previous artwork.",
      inputSchema: z.object({
        viewUUID: z.string().describe("Existing viewer UUID returned by a prior get_artwork_image call"),
        objectNumber: z.string().describe("Object number of the artwork to remount into the viewer"),
      }).strict(),
      ...withOutputSchema(ImageInfoOutput),
      // No ui.resourceUri here: this is an app-only tool (visibility:["app"]),
      // and a template binding on a tool the user never sees is contradictory.
      // The iframe consumes the result directly via app.callServerTool(); it
      // never relies on the host re-rendering a resource. ChatGPT warns when a
      // template is bound to a hidden tool ("templates tied to hidden tools
      // won't be usable") — the binding lives on get_artwork_image only.
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    withLogging("remount_viewer", async (args) => {
      const queue = viewerQueues.get(args.viewUUID);
      if (!queue) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: "No active viewer for this UUID",
        };
        return {
          ...structuredResponse(errorData, "No active viewer — call get_artwork_image to start a new session"),
          isError: true as const,
        };
      }

      const payload = await resolveArtworkImagePayload(args.objectNumber);
      if (!payload.ok) {
        const errorData: InferOutput<typeof ImageInfoOutput> = {
          objectNumber: args.objectNumber,
          error: payload.error,
        };
        return {
          ...structuredResponse(errorData, payload.error),
          isError: true as const,
        };
      }

      // Atomic queue update — UUID and identity preserved, content swapped.
      // Do NOT touch lastPolledAt: the iframe is already polling this UUID
      // and will pick up the new artwork's image on its next render cycle.
      queue.objectNumber = payload.data.objectNumber;
      queue.imageWidth = payload.width;
      queue.imageHeight = payload.height;
      queue.lastAccess = Date.now();

      const viewerData: InferOutput<typeof ImageInfoOutput> = { ...payload.data, viewUUID: args.viewUUID };
      const text = `Remounted viewer ${args.viewUUID.slice(0, 8)} → ${payload.data.objectNumber}`;
      return structuredResponse(viewerData, text);
    })
  );

  // ── inspect_artwork_image ──────────────────────────────────────────

  server.registerTool(
    "inspect_artwork_image",
    {
      title: "Inspect Artwork Image",
      annotations: ANN_READ_CLOSED,
      description:
        "Returns image bytes (base64) for the LLM's own visual analysis of an artwork or region. " +
        "The LLM can see and reason about the image immediately — not for the user to view (use get_artwork_image for the interactive viewer). " +
        "Not for listing or summarising artworks — use search_artwork.\n\n" +
        "Use with region 'full' (default) to inspect the complete artwork, or specify a " +
        "region to zoom into details, read inscriptions, or examine specific areas. " +
        "The response includes cropPixelWidth/cropPixelHeight: the actual pixel dimensions " +
        "of the returned image.\n\n" +
        "Region coordinates: 'pct:x,y,w,h' (percentage of full image, recommended), " +
        "'crop_pixels:x,y,w,h' (pixel coordinates of the full image — use with " +
        "nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF " +
        "pixels, equivalent to crop_pixels). Quick reference:\n" +
        "- Top-left quarter: pct:0,0,50,50\n" +
        "- Bottom-right quarter: pct:50,50,50,50\n" +
        "- Center strip: pct:25,25,50,50\n" +
        "- Full image: full (default)\n" +
        "- For multi-panel works: use physical dimensions from get_artwork_details to estimate panel percentages, then inspect individual panels with close-up crops.\n\n" +
        "Iterative zoom: start with region 'full' to understand the layout, then use close-up crops " +
        "(600–800px) to read specific features. When a viewer is open for this artwork, it automatically " +
        "zooms to the inspected region (navigateViewer defaults to true, no effect when region is 'full'), " +
        "keeping the viewer in sync with your analysis — no separate navigate_viewer call needed for basic zoom.\n\n" +
        "The response includes the active viewUUID (if any) for follow-up navigate_viewer calls.",
      inputSchema: z.object({
        objectNumber: z
          .string()
          .describe("The object number of the artwork (e.g. 'SK-C-5')"),
        region: z
          .string()
          .default("full")
          .refine(
            (v) => IIIF_REGION_RE.test(v),
            { message: "Invalid IIIF region. Use 'full', 'square', 'x,y,w,h' (pixels), 'pct:x,y,w,h' (percentages), or 'crop_pixels:x,y,w,h' (explicit full-image pixels)." }
          )
          .describe("IIIF region: 'full', 'square', 'pct:x,y,w,h' (percentage), 'crop_pixels:x,y,w,h' (pixels of the full image — use with nativeWidth/nativeHeight from a prior response), or 'x,y,w,h' (legacy IIIF pixels, equivalent to crop_pixels). E.g. 'pct:0,60,40,40' for bottom-left 40%."),
        size: z
          .number()
          .int()
          .min(200)
          .max(2016)
          .default(1568)
          .describe("Width of returned image in pixels (200–2016, default 1568). Defaults align to multiples of 28 for clean LLM coordinate handling: 1568 is Sonnet 4.6's native resolution cap, 2016 is the highest ×28 multiple that stays within Opus 4.7's per-image token budget across common aspect ratios."),
        rotation: z
          .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
          .default(0)
          .describe("Clockwise rotation in degrees"),
        quality: z
          .enum(["default", "gray"])
          .default("default")
          .describe("Image quality — 'gray' can help read inscriptions or signatures"),
        navigateViewer: z.preprocess(stripNullCoerceBool, z.boolean().default(true))
          .describe("Auto-navigate the open viewer to the inspected region (default: true). Only effective when a viewer is open for this artwork."),
        viewUUID: optStr()
          .optional()
          .describe("Target a specific viewer session (from get_artwork_image). When omitted, auto-discovers a viewer for this artwork."),
      }).strict(),
      ...withOutputSchema(InspectImageOutput),
    },
    withLogging("inspect_artwork_image", async (args) => {
      const cropError = (error: string, text?: string, recovery?: OobWarning["details"]) => {
        const data: InferOutput<typeof InspectImageOutput> = {
          objectNumber: args.objectNumber,
          region: args.region,
          requestedSize: args.size,
          rotation: args.rotation,
          quality: args.quality,
          error,
          ...(recovery && {
            regionRecovery: {
              requested: recovery.requested,
              clampedTo: recovery.clamped_to,
              validRange: recovery.valid_range,
            },
          }),
        };
        return {
          ...structuredResponse(data, text ?? error),
          isError: true as const,
        };
      };

      try {
        const loaded = await loadArtworkAndImageInfo(args.objectNumber);
        if (!loaded.ok && loaded.reason === "no_artwork") {
          return cropError(loaded.error);
        }

        // Find active viewer — prefer explicit viewUUID, else pick the most
        // recently accessed queue for this artwork. Recency tie-break is safe
        // for reads (inspect) even though it would be risky for writes; if the
        // caller just placed overlays via navigate_viewer, that queue will be
        // the most recent by construction.
        let activeViewUUID: string | undefined;
        if (args.viewUUID) {
          const q = viewerQueues.get(args.viewUUID);
          if (q && q.objectNumber === args.objectNumber) {
            activeViewUUID = args.viewUUID;
            q.lastAccess = Date.now();
          }
          // don't navigate wrong viewer
        } else {
          // Tie-break on lastAccess using `>=` so the later-inserted viewer wins
          // when two calls landed in the same millisecond (Map iterates in
          // insertion order — later insertions appear later in the loop).
          let bestLastAccess = -Infinity;
          for (const [uuid, q] of viewerQueues) {
            if (q.objectNumber === args.objectNumber && q.lastAccess >= bestLastAccess) {
              activeViewUUID = uuid;
              bestLastAccess = q.lastAccess;
            }
          }
          if (activeViewUUID) {
            viewerQueues.get(activeViewUUID)!.lastAccess = Date.now();
          }
        }

        if (!loaded.ok) {
          return cropError(loaded.error);
        }
        const { artwork, imageInfo } = loaded;

        // Checked before prefix stripping so `requested` in the warning echoes
        // the user's exact input, not the normalized form.
        {
          const oob = checkRegionBounds(args.region, imageInfo.width, imageInfo.height);
          if (oob) {
            return oobError(oob, "Your coordinates fall outside valid bounds — please re-examine the region and retry with a corrected bounding box.", cropError);
          }
        }

        const iiifRegion = args.region.startsWith("crop_pixels:")
          ? (cropPixelsToIiifPixels(args.region) ?? args.region)
          : args.region;

        // Policy: never upscale — interpolated pixels add no real detail for LLM
        // inspection. pct regions suffer from server-side rounding that can yield
        // up to 3px less than the ideal pixel width, so we subtract 3 to stay
        // inside the boundary.
        let effectiveSize = args.size;
        if (imageInfo.width) {
          let regionWidth = imageInfo.width;
          const pctMatch = iiifRegion.match(/^pct:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/);
          const pxMatch = iiifRegion.match(/^(\d+),(\d+),(\d+),(\d+)$/);
          if (pctMatch) {
            regionWidth = Math.max(1, Math.floor(imageInfo.width * parseFloat(pctMatch[3]) / 100) - 3);
          } else if (pxMatch) {
            regionWidth = parseInt(pxMatch[3]);
          } else if (iiifRegion === "square") {
            regionWidth = Math.min(imageInfo.width, imageInfo.height ?? imageInfo.width);
          }
          // region === "full" keeps regionWidth = imageInfo.width
          if (effectiveSize > regionWidth) effectiveSize = regionWidth;
        }

        let base64: string;
        let mimeType: string;
        const fetchStart = performance.now();
        try {
          ({ data: base64, mimeType } = await api.fetchRegionBase64(
            imageInfo.iiifId,
            iiifRegion,
            effectiveSize,
            args.rotation,
            args.quality,
          ));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return cropError(`Failed to fetch image: ${message}`);
        }
        const fetchTimeMs = Math.round(performance.now() - fetchStart);
        const imageBuffer: Buffer<ArrayBufferLike> = Buffer.from(base64, "base64");
        let cropPixelWidth: number | undefined;
        let cropPixelHeight: number | undefined;

        // Report the returned crop's actual pixel dimensions — the model uses them
        // (with nativeWidth/nativeHeight) for crop-local coordinate math on a
        // follow-up navigate_viewer zoom. Non-fatal on error: the image bytes
        // remain valid for the content response.
        try {
          const meta = await sharp(imageBuffer).metadata();
          cropPixelWidth = meta.width;
          cropPixelHeight = meta.height;
        } catch { /* keep dims undefined */ }

        const regionLabel = args.region === "full" ? "full image" : `region ${args.region}`;
        const sizeNote = effectiveSize < args.size ? ` (clamped from ${args.size}px — upscaling not supported)` : "";

        // Auto-navigate viewer to inspected region (non-full only)
        let viewerNavigated = false;
        if (args.navigateViewer && activeViewUUID && iiifRegion !== "full") {
          const queue = viewerQueues.get(activeViewUUID);
          if (queue) {
            queue.commands.push({ action: "navigate", region: iiifRegion });
            queue.lastAccess = Date.now();
            viewerNavigated = true;
          }
        }

        const captionParts = [
          `"${artwork.title}" by ${artwork.creator} — ${args.objectNumber}`,
          `(${regionLabel}, ${effectiveSize}px${sizeNote}, ${fetchTimeMs}ms)`,
        ];
        if (imageInfo.width && imageInfo.height) {
          captionParts.push(`| native ${imageInfo.width}×${imageInfo.height}px`);
        }
        if (cropPixelWidth && cropPixelHeight) {
          captionParts.push(`| crop ${cropPixelWidth}×${cropPixelHeight}px`);
        }
        if (viewerNavigated) captionParts.push("| viewer navigated");
        else if (activeViewUUID) captionParts.push(`| viewer open (${activeViewUUID.slice(0, 8)})`);
        const caption = captionParts.join(" ");

        const content = [
          { type: "image" as const, data: base64, mimeType },
          { type: "text" as const, text: caption },
        ];

        if (!EMIT_STRUCTURED) return { content };
        const inspectData: InferOutput<typeof InspectImageOutput> = {
          objectNumber: args.objectNumber,
          title: artwork.title,
          creator: artwork.creator,
          region: args.region,
          requestedSize: effectiveSize,
          nativeWidth: imageInfo.width,
          nativeHeight: imageInfo.height,
          cropPixelWidth,
          cropPixelHeight,
          cropRegion: iiifRegion,
          rotation: args.rotation,
          quality: args.quality,
          fetchTimeMs,
          viewUUID: activeViewUUID,
          viewerNavigated: viewerNavigated || undefined,
        };
        return {
          content,
          structuredContent: inspectData as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return (((error: string, text?: string) => {
          const data: InferOutput<typeof InspectImageOutput> = {
            objectNumber: args.objectNumber,
            region: args.region,
            requestedSize: args.size,
            rotation: args.rotation,
            quality: args.quality,
            error,
          };
          return {
            ...structuredResponse(data, text ?? error),
            isError: true as const,
          };
        })(`Failed to process artwork: ${message}`));
      }
    })
  );

  // ── navigate_viewer ────────────────────────────────────────────

  const NavigateViewerOutput = {
    viewUUID: z.string(),
    objectNumber: z.string().optional()
      .describe("Object number of the artwork in this viewer session — gives a structuredContent reader the identity needed for a follow-up call without parsing prose."),
    queued: z.number().int(),
    regionRecovery: z.object({
      requested: z.string().describe("The offending region exactly as supplied."),
      clampedTo: z.string().describe("An in-bounds replacement region — retry with this, or a corrected box within validRange."),
      validRange: z.string().describe("Human-readable valid coordinate range."),
    }).optional()
      .describe("Out-of-bounds recovery hint. Present only on an `overlay_region_out_of_bounds` error — mirrors the recovery payload the text channel renders, so a structuredContent reader can self-correct without parsing prose."),
    imageWidth: z.number().int().optional(),
    imageHeight: z.number().int().optional(),
    pendingCommandCount: z.number().int().optional()
      .describe("Commands sitting in the queue that the iframe has not yet drained."),
    lastPolledAt: z.string().optional()
      .describe("ISO timestamp of the iframe's last poll. Absent if the iframe has never polled this session."),
    recentlyPolledByViewer: z.boolean().optional()
      .describe("True if the iframe polled within the last 5s."),
    deliveryState: z.enum(["delivered_recently", "queued_waiting_for_viewer", "no_live_viewer_seen"]).optional()
      .describe("Server's view of command delivery: delivered, queued for an existing-but-offscreen viewer, or no viewer ever connected."),
    error: z.string().optional(),
  };

  server.registerTool(
    "navigate_viewer",
    {
      title: "Navigate Viewer",
      annotations: ANN_VIEWER,
      description:
        "Zooms/pans an already-open viewer to a region — steer the user's view to a detail. " +
        "Requires a viewUUID from a prior get_artwork_image call (the viewer must be open). " +
        "Not for opening the viewer — use get_artwork_image. Not for visual analysis — use inspect_artwork_image.\n\n" +
        "In most cases you do NOT need this tool: inspect_artwork_image already auto-zooms the open viewer to " +
        "whatever region it inspects. Call navigate_viewer only to move the user's view WITHOUT fetching image " +
        "bytes for your own analysis.\n\n" +
        "By default, region coordinates are in full-image space (percentages or pixels of the original image), " +
        "not relative to the current viewport. The same pct:x,y,w,h used in inspect_artwork_image " +
        "will target the identical area in the viewer. Exception: when a command includes relativeTo, " +
        "region is interpreted in that inspected crop's local coordinate space.\n\n" +
        "Region formats:\n" +
        "- 'pct:x,y,w,h' — percentage of full image.\n" +
        "- 'crop_pixels:x,y,w,h' — pixel coordinates of the full image. Use nativeWidth/nativeHeight " +
        "returned by inspect_artwork_image to bound values. When used with relativeTo + relativeToSize, " +
        "crop_pixels is instead interpreted as pixels within that inspected crop.\n" +
        "- 'x,y,w,h' — equivalent to crop_pixels: (legacy IIIF form, kept for compatibility).\n" +
        "- 'full' | 'square' — whole image shortcuts.\n\n" +
        "Out-of-bounds regions are rejected with an `overlay_region_out_of_bounds` warning — " +
        "correct the coordinates and retry. Keep batches under 10 commands per call. The viewer session " +
        "(viewUUID) remains active for 30 minutes of idle inactivity — any polling or navigation resets the clock.\n\n" +
        "Coordinate shortcut: to zoom to a region of a prior inspect_artwork_image crop, use 'relativeTo' with " +
        "the crop's region string and specify 'region' as coordinates within the crop's local space; the server " +
        "projects to full-image space deterministically. Use pct:x,y,w,h for crop-local percentages, or " +
        "crop_pixels:x,y,w,h plus relativeToSize:{width: cropPixelWidth, height: cropPixelHeight} from " +
        "inspect_artwork_image for crop-local rendered pixels.\n\n" +
        "Response field deliveryState reports whether the iframe drained the commands immediately " +
        "(`delivered_recently`), the iframe exists but hasn't polled recently and the commands are " +
        "queued (`queued_waiting_for_viewer` — typical when scrolled out of view), or no iframe has " +
        "connected yet (`no_live_viewer_seen`). In the queued case, the command is preserved " +
        "server-side and will apply automatically when the viewer resumes polling — do not narrate " +
        "this as a delivery failure to the user.",
      inputSchema: z.object({
        viewUUID: z.string().describe("Viewer UUID from a prior get_artwork_image call"),
        commands: z.array(z.object({
          action: z.enum(["navigate"]).describe(
            "Command type — 'navigate' zooms/pans the viewer to region."
          ),
          region: optStr().optional().describe("IIIF region (required): 'full', 'square', 'pct:x,y,w,h', 'crop_pixels:x,y,w,h', or 'x,y,w,h'"),
          relativeTo: optStr().optional().describe(
            "Crop region from a prior inspect_artwork_image call. When provided, " +
            "'region' is interpreted as coordinates within that crop's local space " +
            "and projected to full-image space by the server. Use pct: region values directly, " +
            "or crop_pixels: values with relativeToSize from inspect_artwork_image."
          ),
          relativeToSize: z.object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }).strict().optional().describe(
            "Actual pixel dimensions of the inspected crop, copied from inspect_artwork_image " +
            "cropPixelWidth/cropPixelHeight. Required when relativeTo is set and region uses crop_pixels:."
          ),
        })).min(1).describe("Zoom/pan commands to execute in the viewer, in order"),
      }).strict(),
      ...withOutputSchema(NavigateViewerOutput),
    },
    withLogging("navigate_viewer", async (args) => {
      const navError = (error: string, text?: string, recovery?: OobWarning["details"]) => {
        const data: InferOutput<typeof NavigateViewerOutput> = {
          viewUUID: args.viewUUID, queued: 0, error,
          // queue is resolved below; on the no-viewer path it's undefined, so the
          // identity is simply omitted (nothing to recover anyway).
          ...(queue?.objectNumber && { objectNumber: queue.objectNumber }),
          ...(recovery && {
            regionRecovery: {
              requested: recovery.requested,
              clampedTo: recovery.clamped_to,
              validRange: recovery.valid_range,
            },
          }),
        };
        return { ...structuredResponse(data, text ?? error), isError: true as const };
      };

      // Retry briefly — claude.ai sends get_artwork_image and navigate_viewer
      // as concurrent HTTP POSTs. The Map lookup (0ms) can race ahead of the
      // artwork resolution (~25-30ms) that sets the UUID. Three retries at
      // 100ms intervals cover this with generous margin.
      let queue = viewerQueues.get(args.viewUUID);
      if (!queue) {
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 100));
          queue = viewerQueues.get(args.viewUUID);
          if (queue) break;
        }
      }
      if (!queue) {
        return navError(
          "No active viewer for this UUID",
          "No active viewer for this UUID — open an artwork with get_artwork_image first",
        );
      }

      // Validate region — every command is a navigate and requires one.
      for (const cmd of args.commands) {
        if (!cmd.region) {
          return navError("'navigate' requires a region. Use 'full', 'square', 'x,y,w,h', 'pct:x,y,w,h', or 'crop_pixels:x,y,w,h'.");
        }
        if (!IIIF_REGION_RE.test(cmd.region)) {
          return navError(`Invalid region '${cmd.region}'. Use 'full', 'square', 'x,y,w,h', 'pct:x,y,w,h', or 'crop_pixels:x,y,w,h'.`);
        }
        if (cmd.relativeTo && !parsePctRegion(cmd.relativeTo)) {
          return navError(`Invalid relativeTo '${cmd.relativeTo}'. Must be in pct:x,y,w,h format.`);
        }
        if (cmd.relativeToSize && !cmd.relativeTo) {
          return navError("relativeToSize requires relativeTo. Use it with a crop region from inspect_artwork_image.");
        }
        if (cmd.relativeTo && cmd.region?.startsWith("crop_pixels:") && !cmd.relativeToSize) {
          return navError("relativeTo + crop_pixels requires relativeToSize. Copy { width: cropPixelWidth, height: cropPixelHeight } from the inspect_artwork_image response.");
        }
        if (cmd.relativeTo && cmd.relativeToSize && !cmd.region?.startsWith("crop_pixels:")) {
          return navError("relativeToSize is only valid when region uses crop_pixels:. Omit relativeToSize for pct: crop-local coordinates.");
        }
      }

      // OOB check — reject rather than silent-clamp (P7, #247).
      // Skip when relativeTo is used: the projected coordinates are validated
      // post-projection (see below).
      for (const cmd of args.commands) {
        if (!cmd.region) continue;
        if (cmd.relativeTo) continue;
        const oob = checkRegionBounds(cmd.region, queue.imageWidth, queue.imageHeight);
        if (oob) {
          return oobError(oob, "Your coordinates fall outside valid bounds — please re-examine the image and return a corrected bounding box.", navError);
        }
      }

      // Project relativeTo coordinates to full-image space
      for (const cmd of args.commands) {
        if (cmd.relativeTo && cmd.region) {
          if (cmd.region.startsWith("crop_pixels:") && cmd.relativeToSize) {
            const localOob = checkRegionBounds(cmd.region, cmd.relativeToSize.width, cmd.relativeToSize.height);
            if (localOob) {
              return oobError(localOob, "Your crop-local pixel coordinates fall outside the inspected crop dimensions — please re-examine the crop and return a corrected bounding box.", navError);
            }
          }
          const projected = projectToFullImage(cmd.region, cmd.relativeTo, cmd.relativeToSize);
          if (!projected) {
            return navError(`relativeTo requires 'relativeTo' in pct: format and 'region' in pct: format, or crop_pixels: format with relativeToSize. Got region='${cmd.region}', relativeTo='${cmd.relativeTo}'.`);
          }
          cmd.region = projected;
          const oobPost = checkRegionBounds(cmd.region);
          if (oobPost) {
            return oobError(oobPost, "Projected coordinates fall outside 0-100 — the source region or relativeTo box extends outside the image.", navError);
          }
        }
        delete cmd.relativeTo; // Never forward to viewer
        delete cmd.relativeToSize; // Never forward to viewer
      }

      // Strip crop_pixels: prefix before forwarding — viewer understands plain IIIF pixels (P2, #247)
      for (const cmd of args.commands) {
        if (cmd.region?.startsWith("crop_pixels:")) {
          const plain = cropPixelsToIiifPixels(cmd.region);
          if (plain) cmd.region = plain;
        }
      }

      queue.commands.push(...args.commands);
      queue.lastAccess = Date.now();

      const now = Date.now();
      const deliveryState = computeDeliveryState(queue.lastPolledAt, now);
      const recentlyPolledByViewer = deliveryState === "delivered_recently";

      const navData: InferOutput<typeof NavigateViewerOutput> = {
        viewUUID: args.viewUUID,
        queued: args.commands.length,
        imageWidth: queue.imageWidth,
        imageHeight: queue.imageHeight,
        pendingCommandCount: queue.commands.length,
        lastPolledAt: queue.lastPolledAt != null ? new Date(queue.lastPolledAt).toISOString() : undefined,
        recentlyPolledByViewer,
        deliveryState,
      };

      const shortUuid = args.viewUUID.slice(0, 8);
      const text = (() => {
        switch (deliveryState) {
          case "delivered_recently":
            return `Delivered ${args.commands.length} commands to active viewer ${shortUuid}`;
          case "queued_waiting_for_viewer":
            return `Queued ${args.commands.length} commands for viewer ${shortUuid} (offscreen or paused — will apply when viewer resumes polling)`;
          case "no_live_viewer_seen":
            return `Queued ${args.commands.length} commands for viewer ${shortUuid} (no viewer has connected yet)`;
        }
      })();
      return structuredResponse(navData, text);
    })
  );

  // ── poll_viewer_commands (app-only) ───────────────────────────

  // Mirrors the ViewerCommand interface — the queue holds navigate_viewer's
  // input commands plus inspect_artwork_image's internal auto-zoom push.
  const PollViewerCommandsOutput = {
    commands: z.array(z.object({
      action: z.enum(["navigate"]),
      region: z.string().optional(),
    })).describe("Pending viewer navigation commands drained from the queue, in order. Empty when nothing is queued."),
  };

  registerAppTool(
    server,
    "poll_viewer_commands",
    {
      title: "Poll Viewer Commands",
      annotations: ANN_VIEWER,
      description: "Internal: poll for pending viewer navigation commands",
      inputSchema: z.object({
        viewUUID: z.string(),
      }).strict(),
      ...withOutputSchema(PollViewerCommandsOutput),
      // App-only tool (visibility:["app"]) — no ui.resourceUri. The iframe polls
      // this via app.callServerTool() and reads the result directly; it never
      // needs the host to render a template for it. Avoids ChatGPT's
      // "templates tied to hidden tools won't be usable" warning.
      _meta: {
        ui: {
          visibility: ["app"],
        },
      },
    },
    async (args) => {
      const queue = viewerQueues.get(args.viewUUID);
      if (!queue) return structuredResponse({ commands: [] }, "No pending commands");
      queue.lastAccess = Date.now();
      queue.lastPolledAt = Date.now();
      const commands = queue.commands.splice(0);  // drain
      const text = commands.length ? `${commands.length} commands polled` : "No pending commands";
      return structuredResponse({ commands }, text);
    }
  );
}
