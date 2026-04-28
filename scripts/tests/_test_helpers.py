"""Shared helpers for harvest-script regression tests.

The harvest script's filename contains a hyphen (`harvest-vocabulary-db.py`),
which blocks normal `import`. Both `test-exhibition-dump-parser.py` and
`test-phase4-extractors.py` previously duplicated the `importlib.util` spec
dance to load it. This module centralizes that plus the other test-setup
helpers shared between them.

Test files add `scripts/tests/` to sys.path and then `from _test_helpers import ...`.
"""

import importlib.util
import sqlite3
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent.parent   # scripts/
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
HARVEST_MODULE_PATH = SCRIPT_DIR / "harvest-vocabulary-db.py"


def load_harvest_module():
    """Load and return the `harvest-vocabulary-db.py` module.

    Uses importlib.util because the filename has a hyphen and is not
    importable the usual way.
    """
    spec = importlib.util.spec_from_file_location(
        "harvest_vocabulary_db", HARVEST_MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_exhibition_schema(conn: sqlite3.Connection) -> None:
    """Create the minimal exhibitions + exhibition_members schema used by
    parse_exhibition_dump. Used by the exhibition dump regression test.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS exhibitions (
            exhibition_id INTEGER PRIMARY KEY,
            title_en TEXT,
            title_nl TEXT,
            date_start TEXT,
            date_end TEXT
        );
        CREATE TABLE IF NOT EXISTS exhibition_members (
            exhibition_id INTEGER NOT NULL,
            hmo_id TEXT NOT NULL,
            PRIMARY KEY (exhibition_id, hmo_id)
        );
        """
    )


def run_test_functions(tests, *args, **kwargs) -> int:
    """Run a list of test functions, printing PASS/FAIL per name, and return
    a 0/1 exit code. Each test raises AssertionError to signal a failure;
    any other exception propagates.
    """
    failed = 0
    for t in tests:
        try:
            t(*args, **kwargs)
            print(f"  PASS  {t.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


class CheckRecorder:
    """Minimal assertion tally for framework-less tests.

    The project convention (CLAUDE.md "Tests") is standalone scripts with
    hand-rolled assertions rather than pytest/unittest. This class is the
    canonical form of the `check()` + pass/fail-list pattern that was
    previously copy-pasted across several test files. Use it via the
    module-level `check` convenience when you want one recorder per test
    run, or instantiate directly for nested suites.
    """

    def __init__(self) -> None:
        self.passes: list[str] = []
        self.failures: list[str] = []

    def check(self, name: str, cond: bool, detail: str = "") -> None:
        if cond:
            self.passes.append(name)
        else:
            self.failures.append(f"{name}: {detail}")

    def summary(self) -> str:
        return f"PASS: {len(self.passes)}  FAIL: {len(self.failures)}"

    def exit_code(self) -> int:
        return 0 if not self.failures else 1


def create_phase4_schema(conn: sqlite3.Connection) -> None:
    """Create the minimal artworks/mappings/vocabulary schema used by
    run_phase4's bootstrap block. Used by the Phase 4 extractor regression test.
    """
    conn.executescript(
        """
        CREATE TABLE artworks (
            object_number TEXT PRIMARY KEY,
            tier2_done INTEGER DEFAULT 0,
            linked_art_uri TEXT
        );
        CREATE TABLE mappings (
            object_number TEXT,
            vocab_id TEXT,
            field TEXT
        );
        CREATE TABLE vocabulary (
            id TEXT PRIMARY KEY,
            type TEXT,
            label_en TEXT
        );
        """
    )
    conn.commit()
