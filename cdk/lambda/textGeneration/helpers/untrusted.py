"""Helpers for placing untrusted text (retrieved documents, user input) inside prompts."""


def escape_untrusted(text: str) -> str:
    """Neutralise angle brackets so untrusted text cannot close or forge the delimiter tags."""
    return (text or "").replace("<", "&lt;").replace(">", "&gt;")


def truncate(text: str, limit: int = 12000) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n...[truncated {len(text) - limit} chars]..."
