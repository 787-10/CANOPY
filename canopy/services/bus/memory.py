from __future__ import annotations

import asyncio
import fnmatch
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel

log = logging.getLogger(__name__)


class Bus(Protocol):
    async def publish(self, topic: str, event: BaseModel) -> None: ...

    def subscribe(
        self, topic_pattern: str
    ) -> AsyncIterator[tuple[str, BaseModel]]: ...


@dataclass
class _Subscription:
    pattern: str
    queue: asyncio.Queue[tuple[str, BaseModel]]
    closed: bool = field(default=False)


class InProcessBus:
    """Single-process asyncio pub/sub.

    Subscribers receive every published event whose topic matches their pattern
    (fnmatch glob). Each subscriber has its own bounded queue; overflow drops
    the new event with a warning rather than blocking the publisher.

    All operations assume a single event loop (no thread-safety).
    """

    def __init__(self, *, queue_maxsize: int = 1024) -> None:
        self._queue_maxsize = queue_maxsize
        self._subs: list[_Subscription] = []
        self._delivery_count = 0

    async def publish(self, topic: str, event: BaseModel) -> None:
        for sub in list(self._subs):
            if sub.closed or not fnmatch.fnmatchcase(topic, sub.pattern):
                continue
            try:
                sub.queue.put_nowait((topic, event))
                self._delivery_count += 1
            except asyncio.QueueFull:
                log.warning(
                    "bus overflow: dropping event topic=%s pattern=%s qsize=%d",
                    topic,
                    sub.pattern,
                    sub.queue.qsize(),
                )

    def subscribe(
        self, topic_pattern: str
    ) -> AsyncIterator[tuple[str, BaseModel]]:
        sub = _Subscription(
            pattern=topic_pattern,
            queue=asyncio.Queue(maxsize=self._queue_maxsize),
        )
        self._subs.append(sub)
        return self._stream(sub)

    async def _stream(
        self, sub: _Subscription
    ) -> AsyncIterator[tuple[str, BaseModel]]:
        try:
            while not sub.closed:
                item = await sub.queue.get()
                try:
                    yield item
                finally:
                    sub.queue.task_done()
        finally:
            sub.closed = True
            if sub in self._subs:
                self._subs.remove(sub)

    async def drain(self) -> None:
        """Wait until all currently active subscribers finish cascaded work.

        A subscriber may publish another event while handling its current one,
        so a single queue ``join`` is insufficient.  Wait until two event-loop
        turns pass without another delivery after every subscription reports
        its queued work complete.
        """
        stable_turns = 0
        observed_deliveries = self._delivery_count
        while stable_turns < 2:
            queues = [sub.queue for sub in list(self._subs) if not sub.closed]
            if queues:
                await asyncio.gather(*(queue.join() for queue in queues))
            await asyncio.sleep(0)
            if self._delivery_count == observed_deliveries:
                stable_turns += 1
            else:
                stable_turns = 0
                observed_deliveries = self._delivery_count

    def close(self) -> None:
        for sub in self._subs:
            sub.closed = True
        self._subs.clear()
