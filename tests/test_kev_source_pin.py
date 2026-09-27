"""Production Kev must launch only the source that its server attests to serving."""
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reservation_body import KevHTTP


class KevSourcePinTest(unittest.TestCase):
    def test_committed_source_matches_launch_pin(self):
        self.assertEqual(hashlib.sha256(KevHTTP.SOURCE.read_bytes()).hexdigest(), KevHTTP.SOURCE_SHA256)

    def test_changed_source_is_rejected_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'serve_gated.py'
            source.write_bytes(KevHTTP.SOURCE.read_bytes() + b'\n# changed\n')
            with patch.object(KevHTTP, 'SOURCE', source):
                with self.assertRaisesRegex(RuntimeError, 'unqualified Kev service'):
                    KevHTTP(Path(directory) / 'borrower')


if __name__ == '__main__':
    unittest.main()
