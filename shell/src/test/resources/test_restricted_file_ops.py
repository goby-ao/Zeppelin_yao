# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


helper = Path(__file__).resolve().parents[2] / 'main/resources/restricted_file_ops.py'
policy = runpy.run_path(str(helper))


class FilePolicyTest(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        base = Path(self.workspace.name).resolve()
        self.home, self.tmp = base / 'home', base / 'tmp'
        self.home.mkdir(mode=0o700)
        self.tmp.mkdir(mode=0o700)
        self.outside = base / 'outside.txt'
        self.outside.write_text('outside')

    def invoke(self, cmd, *args):
        policy['run'](cmd, args, os.geteuid(), self.home, self.tmp)

    def test_file_copy_and_no_replace(self):
        self.invoke('mkdir', '-p', 'a/b')
        (self.home / 'a/b/source').write_text('content')
        dest = self.tmp / 'dest'
        self.invoke('cp', 'a/b/source', str(dest))
        self.assertEqual('content', dest.read_text())
        with self.assertRaises(FileExistsError):
            self.invoke('cp', 'a/b/source', str(dest))
        self.assertEqual([dest], list(self.tmp.iterdir()))
        self.assertEqual('content', dest.read_text())

    def test_confines_paths_and_linked_files(self):
        with self.assertRaises(policy['Rejected']):
            self.invoke('cat', str(self.outside))
        (self.home / 'link').symlink_to(self.outside)
        with self.assertRaises(policy['Rejected']):
            self.invoke('cat', 'link')
        os.link(self.outside, self.home / 'hardlink')
        with self.assertRaises(policy['Rejected']):
            self.invoke('cat', 'hardlink')
        with self.assertRaises(policy['Rejected']):
            self.invoke('mkdir', '../outside-dir')
        with self.assertRaises(policy['Rejected']):
            self.invoke('stat', '.ssh')

    def test_remove_one_own_file_in_each_allowed_root(self):
        for root in (self.home, self.tmp):
            file = root / 'sample.txt'
            file.write_text('test')
            self.invoke('rm', str(file))
            self.assertFalse(file.exists())
            self.assertTrue(root.is_dir())

    def test_remove_rejects_flags_links_and_paths_outside_roots(self):
        inside = self.home / 'sample.txt'
        inside.write_text('keep')
        link = self.home / 'link'
        link.symlink_to(self.outside)
        hardlink = self.home / 'hardlink'
        os.link(self.outside, hardlink)
        for args in [('-rf', 'sample.txt'), ('*',), ('sample.txt', 'link'), ('.',),
                     ('link',), ('hardlink',), (str(self.outside),)]:
            with self.subTest(args=args), self.assertRaises(policy['Rejected']):
                self.invoke('rm', *args)
        self.assertEqual('outside', self.outside.read_text())
        self.assertEqual('keep', inside.read_text())
        self.assertTrue(link.is_symlink())
        self.assertTrue(hardlink.exists())

    def test_cli_prints_chinese_policy_message(self):
        result = subprocess.run([sys.executable, '-B', str(helper), '', 'stat', '.'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(1, result.returncode)
        self.assertIn('根据安全管理规范，文件操作已拦截。当前账号不符合运行身份要求',
                      result.stderr.decode('utf-8'))


if __name__ == '__main__':
    unittest.main()
