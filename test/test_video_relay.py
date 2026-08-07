#!/usr/bin/env python3
"""Unit tests for the pure parts of the debug video relay.

Deliberately narrow: only the bits with no ROS and no event loop in them — the
normalisation maths and the drop-when-busy decision. Everything else in
approval_node is exercised by the smoke test in the task brief.

Run with:  python3 -m pytest src/bv_gcs/test/test_video_relay.py
"""

import pytest

from bv_gcs.approval_node import (
    VIDEO_BACKLOG_DROP_BYTES,
    normalise_detections,
    should_send_video,
    video_backlog_bytes,
)


class FakeVec:
    """Stands in for geometry_msgs/Vector3: x, y are pixels and z is the class id."""

    def __init__(self, x, y, z):
        self.x, self.y, self.z = x, y, z


# -- normalisation -------------------------------------------------------------


def test_centre_pixel_maps_to_centre_of_frame():
    dets = normalise_detections([FakeVec(2320.0, 1740.0, 0)], 4640.0, 3480.0)
    assert dets == [
        {'x': 0.5, 'y': 0.5, 'class_id': 0, 'class_name': 'person'}]


def test_height_is_not_derived_from_width():
    """The whole point of two parameters.

    The same pixel row normalises differently on the 4:3 real camera and the
    16:9 Gazebo camera. If height were derived from width by assuming an aspect
    ratio, one of these two would be wrong.
    """
    px = FakeVec(640.0, 360.0, 1)
    sim = normalise_detections([px], 1280.0, 720.0)[0]
    real = normalise_detections([px], 4640.0, 3480.0)[0]
    assert sim['y'] == pytest.approx(0.5)
    assert real['y'] == pytest.approx(360.0 / 3480.0)
    assert sim['y'] != real['y']


def test_class_name_comes_from_the_shared_table():
    dets = normalise_detections(
        [FakeVec(0.0, 0.0, 0), FakeVec(0.0, 0.0, 1), FakeVec(0.0, 0.0, 7)],
        1280.0, 720.0)
    assert [d['class_name'] for d in dets] == ['person', 'tent', 'class_7']
    assert [d['class_id'] for d in dets] == [0, 1, 7]


def test_empty_detection_list_is_not_an_error():
    assert normalise_detections([], 1280.0, 720.0) == []


@pytest.mark.parametrize('width,height', [(0.0, 720.0), (1280.0, 0.0), (-1.0, -1.0)])
def test_non_positive_dimensions_yield_no_markers_rather_than_dividing_by_zero(
        width, height):
    assert normalise_detections([FakeVec(1.0, 2.0, 0)], width, height) == []


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
