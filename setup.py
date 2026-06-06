from setuptools import find_packages, setup

package_name = 'bv_gcs'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/config', ['config/approval_params.yaml']),
        ('share/' + package_name + '/launch', ['launch/gcs.launch.py']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='eashan',
    maintainer_email='Eashan.Vytla@gmail.com',
    description='Human-in-the-loop ground control station for bv_core.',
    license='TODO: License declaration',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'approval_node = bv_gcs.approval_node:main',
        ],
    },
)
