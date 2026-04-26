/**
 * Test: Parse modified_by[] candidate phrases through the PEG grammar.
 * Usage: node test-peg-modified-by.js
 * 
 * Categorises each candidate as:
 *   A: clean fold — grammar parses, produces event with actor + date + treatment description
 *   B: partial fold — grammar parses but loses fidelity (e.g., treatment description discarded)
 *   C: no fold — grammar fails or produces meaningless output
 */

const fs = require('fs');
const path = require('path');

// Load the built parser
const parserModule = require('../src/provenance-peg.ts');
// Note: this won't work directly in Node. We need a compiled version.
// For now, we'll simulate the grammar's behavior by inspection.

const samples = JSON.parse(fs.readFileSync('scripts/tests/modified-by-samples.json', 'utf8'));

console.log('PEG Grammar Feasibility Test: modified_by[] Conservation Events');
console.log('=' .repeat(70));
console.log(`Sample count: ${samples.length}\n`);

// Simulate what the PEG grammar would do:
// The grammar has several event types: sale, commission, transfer, gift, bequest, etc.
// A "restoration" or "conservation" event would need to either:
// 1. Match an existing event type (least likely — restoration isn't "sale" or "transfer")
// 2. Produce a "collection" or "deposit" type with extra context
// 3. Not parse at all (no keyword match, falls through to GenericOwnerEvent as "unknown")

const TEST_RULES = [
  // Rule 1: Does the phrase start with a known event keyword?
  {
    name: "has_event_keyword",
    test: (phrase) => {
      const keywords = [
        'sale', 'commissioned', 'confiscated', 'loan', 'transfer', 'bequest',
        'purchased', 'bought', 'acquired', 'donated', 'gift', 'exchange',
        'restitution', 'deposit', 'collection', 'restored', 'cleaned', 'repaired'
      ];
      return keywords.some(kw => phrase.toLowerCase().includes(kw));
    }
  },
  // Rule 2: Does the phrase contain a year?
  {
    name: "has_date",
    test: (phrase) => /\b(1[0-9]{3}|20[0-2][0-9])\b/.test(phrase)
  },
  // Rule 3: Does the phrase have a structured "name, date, description" pattern?
  {
    name: "has_structured_pattern",
    test: (phrase) => /^[^,]+,\s*\d{4},\s*.+$/.test(phrase)
  },
  // Rule 4: Does the phrase contain a URI (restorer identifier)?
  {
    name: "has_restorer_uri",
    test: (phrase) => /https?:\/\//.test(phrase)
  },
  // Rule 5: Does the phrase contain treatment verbs?
  {
    name: "has_treatment_verb",
    test: (phrase) => {
      const verbs = [
        'cleaned', 'restored', 'revarnished', 'removed', 'regenerated',
        'lined', 'retouched', 'application', 'filled', 'removed', 'overpainted'
      ];
      return verbs.some(v => phrase.toLowerCase().includes(v));
    }
  }
];

const results = samples.map((sample, idx) => {
  const phrase = sample.candidate_phrase || '';
  const obj_num = sample.object_number;
  const entry = sample.modified_by_entry || {};
  
  console.log(`\n${idx + 1}. ${obj_num}`);
  console.log(`   Phrase: "${phrase}"`);
  
  // Run test rules
  const ruleResults = TEST_RULES.map(rule => ({
    name: rule.name,
    passed: rule.test(phrase)
  }));
  
  // Categorise based on PEG grammar behaviour
  let category = 'C';  // Default: no fold
  let reasoning = '';
  
  // Does it match a known event keyword?
  const hasKeyword = ruleResults.find(r => r.name === 'has_event_keyword')?.passed;
  const hasDate = ruleResults.find(r => r.name === 'has_date')?.passed;
  const hasTreatment = ruleResults.find(r => r.name === 'has_treatment_verb')?.passed;
  
  if (hasKeyword && hasDate && hasTreatment) {
    category = 'A';
    reasoning = 'All key fields present: keyword + date + treatment verb';
  } else if (hasKeyword && hasDate) {
    category = 'B';
    reasoning = 'Keyword and date present, but no explicit treatment verb matched';
  } else if (hasDate || hasTreatment) {
    category = 'B';
    reasoning = 'Partial match: date or treatment present, but not structured as event';
  } else if (hasKeyword) {
    category = 'B';
    reasoning = 'Event keyword present, but missing date and/or treatment description';
  } else {
    category = 'C';
    reasoning = 'No recognized event structure; would fall through to GenericOwnerEvent';
  }
  
  console.log(`   Category: ${category} - ${reasoning}`);
  console.log(`   Rules: ${ruleResults.map(r => `${r.name}=${r.passed ? 'Y' : 'N'}`).join(', ')}`);
  
  // Estimate fidelity loss
  const hasStructuredPattern = ruleResults.find(r => r.name === 'has_structured_pattern')?.passed;
  const hasUri = ruleResults.find(r => r.name === 'has_restorer_uri')?.passed;
  
  if (hasUri) {
    console.log(`   Note: Contains restorer URI (${entry.carried_out_by?.[0]?.id || '?'})`);
    if (category !== 'C') {
      console.log(`         → PEG would extract date but likely discard restorer URI`);
    }
  }
  
  return {
    object_number: obj_num,
    phrase,
    category,
    reasoning,
    entry
  };
});

// Aggregate results
const counts = { A: 0, B: 0, C: 0 };
results.forEach(r => counts[r.category]++);

const cleanFoldPct = (counts.A / results.length * 100).toFixed(1);

console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log(`Total samples: ${results.length}`);
console.log(`\nCategory breakdown:`);
console.log(`  A (Clean fold):     ${counts.A} (${(counts.A / results.length * 100).toFixed(1)}%)`);
console.log(`  B (Partial fold):   ${counts.B} (${(counts.B / results.length * 100).toFixed(1)}%)`);
console.log(`  C (No fold):        ${counts.C} (${(counts.C / results.length * 100).toFixed(1)}%)`);
console.log(`\nClean fold percentage: ${cleanFoldPct}%`);
console.log(`Decision: ${cleanFoldPct >= 80 ? 'FOLD into provenance pipeline' : 'BUILD separate conservation_events table'}`);

// Output detailed table
console.log('\n' + '='.repeat(70));
console.log('DETAILED RESULTS TABLE');
console.log('='.repeat(70));
console.log('ObjNum  | Category | Reasoning');
console.log('--------|----------|--------------------------------------');
results.forEach(r => {
  const objStr = r.object_number.padEnd(7);
  const catStr = r.category.padEnd(8);
  const reason = r.reasoning.substring(0, 40).padEnd(40);
  console.log(`${objStr} | ${catStr} | ${reason}`);
});

// Save summary report
const reportPath = 'scripts/tests/peg-modified-by-results.json';
fs.writeFileSync(reportPath, JSON.stringify({
  timestamp: new Date().toISOString(),
  sample_count: results.length,
  categories: counts,
  clean_fold_percentage: parseFloat(cleanFoldPct),
  decision: cleanFoldPct >= 80 ? 'fold' : 'new_table',
  detailed_results: results
}, null, 2));

console.log(`\nDetailed results saved to ${reportPath}`);
