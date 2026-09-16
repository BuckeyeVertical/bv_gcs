"""End-laps bridge tests runnable without a ROS installation."""
import ast
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest


def bridge_methods():
    # Load the actual bridge methods without importing ROS/native dependencies.
    source = Path(__file__).parents[1] / 'bv_gcs' / 'approval_node.py'
    tree = ast.parse(source.read_text())
    methods = [method for cls in tree.body if isinstance(cls, ast.ClassDef)
               for method in cls.body if isinstance(method, ast.AsyncFunctionDef)
               and method.name in ('call_end_laps', '_handle_end_laps')]
    namespace = dict(asyncio=asyncio, json=json, DECISION_CALL_TIMEOUT_S=0.01,
                     Trigger=SimpleNamespace(Request=SimpleNamespace),
                     web=SimpleNamespace(WebSocketResponse=object))
    exec(compile(ast.Module(body=methods, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace


@pytest.mark.parametrize('outcome', ['accepted', 'rejected', 'unavailable', 'timeout', 'error', 'send_error'])
def test_end_laps_service_response(outcome):
    async def run():
        methods = bridge_methods()
        future = asyncio.get_running_loop().create_future()
        if outcome == 'error':
            future.set_exception(RuntimeError('service failed'))
        elif outcome != 'timeout':
            future.set_result(SimpleNamespace(success=outcome == 'accepted', message=outcome))
        client = Mock()
        client.service_is_ready.return_value = outcome != 'unavailable'
        client.call_async.return_value = future
        if outcome == 'send_error':
            client.call_async.side_effect = RuntimeError("service disconnected")
        accepted, message = await methods['call_end_laps'](SimpleNamespace(end_laps_client=client))
        assert accepted == (outcome == 'accepted')
        assert message
        if outcome == 'unavailable':
            client.call_async.assert_not_called()
        else:
            client.call_async.assert_called_once()
    asyncio.run(run())


def test_websocket_ack_reports_core_rejection():
    async def run():
        ws = SimpleNamespace(send_str=AsyncMock())
        node = SimpleNamespace(call_end_laps=AsyncMock(return_value=(False, 'Not in laps')))
        await bridge_methods()['_handle_end_laps'](SimpleNamespace(node=node), ws)
        assert json.loads(ws.send_str.call_args.args[0]) == {
            'type': 'end_laps_ack', 'accepted': False, 'message': 'Not in laps'}
    asyncio.run(run())
