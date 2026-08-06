import os

from setuptools import find_packages, setup

package_name = 'bv_gcs'


def frontend_data_files():
    """Install web/dist if it has been built.

    The build is optional: during development the vite dev server serves the
    frontend instead, and approval_node falls back to a placeholder page. Run
    `cd web && npm run build` before colcon build to ship the bundle on the drone.
    """
    dist_root = os.path.join(os.path.dirname(__file__), 'web', 'dist')
    if not os.path.isdir(dist_root):
        return []

    entries = []
    for dirpath, _dirnames, filenames in os.walk(dist_root):
        if not filenames:
            continue
        rel = os.path.relpath(dirpath, dist_root)
        target = os.path.join('share', package_name, 'web', 'dist')
        if rel != '.':
            target = os.path.join(target, rel)
        entries.append(
            (target, [os.path.join(dirpath, f) for f in filenames]))
    return entries


setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/config', ['config/approval_params.yaml']),
        ('share/' + package_name + '/launch', ['launch/gcs.launch.py']),
    ] + frontend_data_files(),
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='eashan',
    maintainer_email='Eashan.Vytla@gmail.com',
    description='Human-in-the-loop ground control station for bv_core.',
    license='TODO: License declaration',
    entry_points={
        'console_scripts': [
            'approval_node = bv_gcs.approval_node:main',
            'fake_pending = bv_gcs.fake_pending:main',
        ],
    },
)
