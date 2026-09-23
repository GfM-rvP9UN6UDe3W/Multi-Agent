"""SPEC-0021 N: the Python package is orchvia, and its protocol identifiers did not change."""
import importlib
import unittest


class NamingTest(unittest.TestCase):
    def test_0021_n01_the_package_imports_as_orchvia_only(self) -> None:
        orchvia = importlib.import_module("orchvia")
        self.assertTrue(hasattr(orchvia, "Orchestrator"))
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("agent_orch")

    def test_0021_n06_request_digest_is_unchanged(self) -> None:
        from orchvia.identity import request_digest

        digest = request_digest("tasks.create", {
            "spec": {"goal": "golden", "runtime": {"provider": "fake", "model": "fixture"}},
            "idempotencyKey": "golden-key",
        })
        self.assertEqual(digest, "1c80623de78828db9bac7c2b57dd9bb31969bdb70f2b2f5627795bf28232dc42")


if __name__ == "__main__":
    unittest.main()
