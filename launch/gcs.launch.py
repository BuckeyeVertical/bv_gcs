"""Launch the GCS bridge on its own.

Normally you'd bring this up via bv_core's mission.launch.py with
human_approval_required:=true. This file is for running the bridge alone — against a
recorded bag, against the fake_pending stub, or while developing the frontend.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node
from launch_ros.parameter_descriptions import ParameterValue


def generate_launch_description():
    ws_port = DeclareLaunchArgument(
        'ws_port', default_value='8765',
        description='Port for the GCS HTTP + WebSocket server.')

    approval_params = os.path.join(
        get_package_share_directory('bv_gcs'),
        'config', 'approval_params.yaml')

    approval_node = Node(
        package='bv_gcs',
        executable='approval_node',
        name='approval_node',
        output='both',
        parameters=[
            approval_params,
            # value_type=int: a bare LaunchConfiguration resolves to a string, which
            # would clash with the node's integer parameter declaration.
            {'ws_port': ParameterValue(
                LaunchConfiguration('ws_port'), value_type=int)},
        ],
    )

    return LaunchDescription([
        ws_port,
        approval_node,
    ])
