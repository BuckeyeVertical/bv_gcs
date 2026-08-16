#!/usr/bin/env python3
"""Unit tests for the pure parts of the debug video relay.

Deliberately narrow: only the bits with no ROS and no event loop in them — the
fMP4 init-segment cache and the drop-when-busy decision. Everything else in
approval_node is exercised by the smoke test in the task brief.

Run with:  python3 -m pytest src/bv_gcs/test/test_video_relay.py
"""

import pytest

from bv_gcs import approval_node
from bv_gcs.approval_node import (
    MAX_BOX_BYTES,
    MAX_INIT_SEGMENT_BYTES,
    VIDEO_BACKLOG_DROP_BYTES,
    VideoInitCache,
    should_send_video,
    video_backlog_bytes,
)


def test_frontend_dist_resolves_symlink_install(tmp_path, monkeypatch):
    source_dist = tmp_path / 'source' / 'dist'
    source_dist.mkdir(parents=True)
    (source_dist / 'index.html').write_text('<div id="root"></div>')

    install_dist = tmp_path / 'install' / 'web' / 'dist'
    install_dist.mkdir(parents=True)
    (install_dist / 'index.html').symlink_to(source_dist / 'index.html')

    monkeypatch.setattr(
        approval_node,
        'get_package_share_directory',
        lambda _package: str(tmp_path / 'install'),
    )

    assert approval_node.find_frontend_dist() == str(source_dist.resolve())


# -- drop-when-busy ------------------------------------------------------------


def test_idle_transport_sends():
    assert should_send_video(0) is True


def test_backlog_at_the_threshold_still_sends():
    assert should_send_video(VIDEO_BACKLOG_DROP_BYTES) is True


def test_backlog_past_the_threshold_drops():
    assert should_send_video(VIDEO_BACKLOG_DROP_BYTES + 1) is False


class FakeTransport:
    def __init__(self, size):
        self._size = size

    def get_write_buffer_size(self):
        if isinstance(self._size, Exception):
            raise self._size
        return self._size


class FakeWriter:
    def __init__(self, transport):
        self.transport = transport


class FakeWs:
    def __init__(self, writer):
        self._writer = writer


def test_backlog_is_read_from_the_transport():
    assert video_backlog_bytes(FakeWs(FakeWriter(FakeTransport(4096)))) == 4096


@pytest.mark.parametrize('ws', [
    FakeWs(None),                                   # no writer yet
    FakeWs(FakeWriter(None)),                       # writer without a transport
    object(),                                       # not a websocket at all
    FakeWs(FakeWriter(FakeTransport(RuntimeError('closing')))),
])
def test_unreadable_backlog_degrades_to_sending(ws):
    """Unknown backlog must mean "send", not "never send".

    Guessing high here would silently kill the stream on any aiohttp version
    whose internals differ; guessing low leaves a stuck client bounded by the
    transport's own flow control, which is worse but not broken.
    """
    assert video_backlog_bytes(ws) == 0
    assert should_send_video(video_backlog_bytes(ws)) is True


# -- init segment cache --------------------------------------------------------
#
# The bug these cover: the relay is stateless, the encoder emits ftyp+moov exactly
# once at start, so a browser opening /video mid-stream got a bare `moof` as its
# first appendBuffer, MSE rejected it and the <video> died with error code 4.


def box(kind: bytes, payload_len: int) -> bytes:
    """One complete top-level MP4 box of `8 + payload_len` bytes."""
    return (8 + payload_len).to_bytes(4, 'big') + kind + b'\x00' * payload_len


def test_nothing_is_cached_before_the_encoder_starts():
    assert VideoInitCache().snapshot() == []


def test_ftyp_and_moov_are_remembered_and_media_is_not():
    cache = VideoInitCache()
    ftyp, moov = box(b'ftyp', 24), box(b'moov', 853)
    for chunk in (ftyp, moov, box(b'moof', 88), box(b'mdat', 1799)):
        cache.observe(chunk)
    assert cache.snapshot() == [ftyp, moov]


def test_split_mdat_payload_is_never_mistaken_for_an_init_segment():
    """The encoder sends a bare 8-byte `mdat` header, then its payload separately.

    The payload is arbitrary H.264 and can begin with any four bytes at all,
    including b'moov'. Parsing each chunk from its first byte would cache that
    payload and then feed it to every future client as a header.
    """
    cache = VideoInitCache()
    cache.observe(box(b'ftyp', 24))
    cache.observe(box(b'moov', 853))
    header = (8 + 32).to_bytes(4, 'big') + b'mdat'   # header chunk, payload follows
    cache.observe(header)
    cache.observe(b'\x00\x00\x00\x20moov' + b'\x00' * 24)  # payload that looks like a box
    assert len(cache.snapshot()) == 2
    assert all(c[4:8] in (b'ftyp', b'moov') for c in cache.snapshot())


def test_a_new_ftyp_replaces_the_cached_init_rather_than_appending():
    """A tier or resolution change rebuilds the encoder and emits a fresh header.

    Replaying the stale one would hand the operator a decoder configured for the
    previous stream.
    """
    cache = VideoInitCache()
    cache.observe(box(b'ftyp', 24))
    cache.observe(box(b'moov', 853))
    new_ftyp, new_moov = box(b'ftyp', 28), box(b'moov', 900)
    cache.observe(new_ftyp)
    cache.observe(new_moov)
    assert cache.snapshot() == [new_ftyp, new_moov]


def test_cache_is_bounded():
    cache = VideoInitCache()
    cache.observe(box(b'ftyp', 24))
    for _ in range(40):
        cache.observe(box(b'moov', MAX_INIT_SEGMENT_BYTES // 4))
    assert sum(len(c) for c in cache.snapshot()) <= MAX_INIT_SEGMENT_BYTES


def test_short_chunk_does_not_raise():
    cache = VideoInitCache()
    cache.observe(b'\x00\x00')
    assert cache.snapshot() == []


def test_observe_reports_fragment_boundaries():
    """A new client may only be admitted where a `moof` starts.

    Chunks are arbitrary slices: `mdat` arrives as a bare 8-byte header followed
    by its payload. Handing a client the payload chunk would begin its stream
    with the tail of a fragment whose header it never saw.
    """
    cache = VideoInitCache()
    assert cache.observe(box(b'ftyp', 24)) is False
    assert cache.observe(box(b'moov', 853)) is False
    assert cache.observe(box(b'moof', 88)) is True
    header = (8 + 16).to_bytes(4, 'big') + b'mdat'
    assert cache.observe(header) is False
    assert cache.observe(b'\x00' * 16) is False        # payload, mid-box
    assert cache.observe(box(b'moof', 88)) is True


def test_mdat_payload_that_looks_like_moof_is_not_a_boundary():
    cache = VideoInitCache()
    cache.observe((8 + 16).to_bytes(4, 'big') + b'mdat')
    assert cache.observe(b'\x00\x00\x00\x10moof' + b'\x00' * 8) is False


def test_relay_started_mid_stream_resynchronises_on_the_next_ftyp():
    """The reason a restarted relay used to stay dark until the encoder restarted.

    The first chunk a mid-stream relay ever sees is the middle of a `mdat`. Read
    as a box header, its first four bytes are a length taken from H.264 payload —
    routinely hundreds of megabytes — and every chunk after it is then consumed
    as "still inside that box". No boundary is ever reported, so no client is
    ever admitted to the live stream and no init segment is ever cached, even
    once the encoder does restart and send a real one.
    """
    cache = VideoInitCache()
    cache.observe(b'\x09\x30\x00\x00' + b'\xff' * 4092)   # mid-mdat payload
    cache.observe(b'\x00\xa1\xb2\xc3' + b'\x01' * 2000)   # more payload
    ftyp, moov = box(b'ftyp', 24), box(b'moov', 853)
    cache.observe(ftyp)
    cache.observe(moov)
    assert cache.snapshot() == [ftyp, moov]
    assert cache.observe(box(b'moof', 88)) is True


def test_absurd_box_length_does_not_swallow_the_stream():
    cache = VideoInitCache()
    cache.observe((MAX_BOX_BYTES + 1).to_bytes(4, 'big') + b'mdat')
    assert cache.observe(box(b'moof', 88)) is True
