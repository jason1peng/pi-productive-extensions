"""Process-group lifecycle guard for the isolated DSM host smoke."""

from contextlib import contextmanager
import os
import signal
import subprocess
import time
from collections.abc import Callable, Iterator


_MANAGED_SIGNALS = (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)


def _process_group_exists(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can report EPERM while an orphan zombie still names the group.
        return True


def _process_group_has_live_members(group_id: int) -> bool:
    """Distinguish running members from orphan zombies awaiting OS reaping."""
    process_table = subprocess.run(
        ["ps", "-axo", "pgid=,stat="],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    for line in process_table.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[0].isdigit():
            if int(fields[0]) == group_id and not fields[1].startswith("Z"):
                return True
    return False


def terminate_process_group(process: subprocess.Popen, grace_seconds: float = 10) -> None:
    """Terminate a detached process group, reap its leader, and confirm no live members."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    else:
        deadline = time.monotonic() + grace_seconds
        while _process_group_exists(process.pid) and _process_group_has_live_members(process.pid):
            if time.monotonic() >= deadline:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                break
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))

    process.wait()

    # Reaping the leader and killing the group are separate kernel events. An
    # orphaned descendant can remain visible to killpg after SIGKILL as a zombie,
    # but it cannot execute or outlive cleanup as a live process. Continue to
    # reject any live member without depending on OS orphan-reaping latency.
    deadline = time.monotonic() + max(1.0, grace_seconds)
    while _process_group_exists(process.pid) and _process_group_has_live_members(process.pid):
        if time.monotonic() >= deadline:
            raise RuntimeError(f"process group {process.pid} retained live members after cleanup")
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))


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
