"""Process-group lifecycle guard for the isolated DSM host smoke."""

from contextlib import contextmanager
import os
import signal
import subprocess
import time
from collections.abc import Callable, Iterator


_MANAGED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)


def terminate_process_group(process: subprocess.Popen, grace_seconds: float = 10) -> None:
    """Terminate a detached process group and separately reap its leader."""
    group_exists = True
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        group_exists = False

    if group_exists:
        deadline = time.monotonic() + grace_seconds
        while True:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            if time.monotonic() >= deadline:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))

    process.wait()


@contextmanager
def process_group_guard(
    process: subprocess.Popen,
    *,
    grace_seconds: float = 10,
    on_cleanup: Callable[[int], None] | None = None,
) -> Iterator[None]:
    """Ensure a detached process group cannot outlive this guarded operation."""
    previous_handlers = {signum: signal.getsignal(signum) for signum in _MANAGED_SIGNALS}

    def interrupted(signum: int, _frame: object) -> None:
        raise SystemExit(128 + signum)

    for signum in _MANAGED_SIGNALS:
        signal.signal(signum, interrupted)
    try:
        yield
    finally:
        # A repeated terminal signal must not interrupt TERM/KILL escalation or wait.
        for signum in _MANAGED_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
        if on_cleanup is not None:
            on_cleanup(process.pid)
        terminate_process_group(process, grace_seconds)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
