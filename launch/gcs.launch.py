"""Standalone launch file for the GCS stack: approval_node + rosbridge_websocket.

Usually you'll launch this indirectly via bv_core/launch/mission.launch.py with
human_approval_required:=true. This file is for running the GCS pieces alone
(e.g. against a recorded bag or while debugging the frontend).
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import AnyLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    rosbridge_port = DeclareLaunchArgument(
        'rosbridge_port', default_value='9090',
        description='Port for the rosbridge_websocket bridge.')

    approval_params = os.path.join(
        get_package_share_directory('bv_gcs'),
        'config', 'approval_params.yaml')

    approval_node = Node(
        package='bv_gcs',
        executable='approval_node',
        name='approval_node',
        output='both',
        parameters=[approval_params],
    )

    rosbridge = IncludeLaunchDescription(
        AnyLaunchDescriptionSource([
            get_package_share_directory('rosbridge_server'),
            '/launch/rosbridge_websocket_launch.xml']),
        launch_arguments={'port': LaunchConfiguration('rosbridge_port')}.items(),
    )

    return LaunchDescription([
        rosbridge_port,
        approval_node,
        rosbridge,
    ])
