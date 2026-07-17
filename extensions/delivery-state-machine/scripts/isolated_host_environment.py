"""Environment isolation for the spawned Pi host used by the DSM smoke."""

from collections.abc import Mapping


def isolated_host_environment(environ: Mapping[str, str]) -> dict[str, str]:
    """Remove caller identity/coordination markers from a copied environment."""
    return {
        key: value
        for key, value in environ.items()
        if key != "PI_CODING_AGENT"
        and not key.startswith("PI_COMS_")
        and not key.startswith("PI_SUBAGENT_")
    }
