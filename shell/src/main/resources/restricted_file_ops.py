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
import pwd
import shutil
import stat
import sys
import uuid
from contextlib import ExitStack
from pathlib import PurePosixPath


LIMIT = 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
PROTECTED = {'.ssh', '.gnupg', '.k5login', '.bashrc', '.bash_profile',
             '.profile', '.hadoop-env', '.hadooprc'}


class Rejected(Exception):
    pass


def split_path(value, home, tmp):
    if not value or value.startswith('-'):
        raise Rejected('ARGUMENT_DENIED')
    path = home / value[2:] if value.startswith('~/') else home / value
    if '..' in path.parts:
        raise Rejected('PATH_DENIED')
    for root in (home, tmp):
        if path == root or root in path.parents:
            parts = path.relative_to(root).parts
            if any(p in PROTECTED or p.endswith('.keytab') for p in parts):
                raise Rejected('PATH_DENIED')
            return root, parts
    raise Rejected('PATH_DENIED')


def walk(stack, path, parent=None, create=False):
    for part in path:
        if create:
            try:
                os.mkdir(part, mode=0o700, dir_fd=parent)
            except FileExistsError:
                pass
        parent = os.open(part, DIR_FLAGS, dir_fd=parent)
        stack.callback(os.close, parent)
    return parent


def regular_file(stack, parent, name):
    if not stat.S_ISREG(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
        raise Rejected('PATH_DENIED')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    stack.callback(os.close, fd)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Rejected('PATH_DENIED')
    return stack.enter_context(os.fdopen(fd, 'rb', closefd=False))


def allowed_args(command, args):
    flag, lines = '', 10
    if args and command == 'ls' and args[0] in ('-l', '-a', '-la', '-al'):
        flag, args = args[0], args[1:]
    if args and command == 'mkdir' and args[0] == '-p':
        flag, args = args[0], args[1:]
    if command in ('head', 'tail') and len(args) == 3 and args[0] == '-n':
        if not args[1].isascii() or not args[1].isdigit() or len(args[1]) > 4:
            raise Rejected('ARGUMENT_DENIED')
        lines, args = int(args[1]), args[2:]
        if not 1 <= lines <= 1000:
            raise Rejected('ARGUMENT_DENIED')
    if command == 'ls' and not args:
        args = ['.']
    if len(args) != (2 if command == 'cp' else 1):
        raise Rejected('ARGUMENT_DENIED')
    if command == 'rm' and any(c in args[0] for c in '*?[]'):
        raise Rejected('ARGUMENT_DENIED')
    return flag, lines, args


def print_entry(parent, name, label):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    print('{} {:>12} {}'.format(stat.filemode(info.st_mode), info.st_size, repr(label)))


def copy_new_file(source, parent, name):
    # Complete the copy before publishing it, and never replace an existing name.
    staging = '.zeppelin-copy-' + uuid.uuid4().hex
    os.mkdir(staging, mode=0o700, dir_fd=parent)
    try:
        with ExitStack() as stack:
            work = walk(stack, [staging], parent)
            fd = os.open('data', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=work)
            try:
                with os.fdopen(fd, 'wb') as target:
                    shutil.copyfileobj(source, target)
                os.link('data', name, src_dir_fd=work, dst_dir_fd=parent, follow_symlinks=False)
            finally:
                os.unlink('data', dir_fd=work)
    finally:
        os.rmdir(staging, dir_fd=parent)


def execute(user, command, args):
    uid = os.geteuid()
    if uid == 0 or pwd.getpwuid(uid).pw_name != user:
        raise Rejected('USER_MISMATCH')
    home, tmp = PurePosixPath('/home') / user, PurePosixPath('/tmp/zeppelin') / user
    run(command, args, uid, home, tmp)


def run(command, args, uid, home, tmp):
    flag, lines, args = allowed_args(command, args)
    paths = [split_path(arg, home, tmp) for arg in args]
    with ExitStack() as stack:
        parents = []
        for root, parts in paths:
            root_fd = walk(stack, root.parts)
            info = os.fstat(root_fd)
            if info.st_uid != uid or (root == tmp and info.st_mode & 0o077):
                raise Rejected('PATH_DENIED')
            parent = walk(stack, parts[:-1], root_fd, create=flag == '-p')
            parents.append((parent, parts[-1] if parts else '.'))
        parent, name = parents[0]
        if command == 'ls':
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                directory = walk(stack, [name], parent)
                for item in sorted(os.listdir(directory)):
                    if 'a' in flag or not item.startswith('.'):
                        if 'l' in flag:
                            print_entry(directory, item, item)
                        else:
                            print(repr(item))
            else:
                print_entry(parent, name, name)
        elif command == 'stat':
            print_entry(parent, name, name)
        elif command == 'mkdir':
            if flag == '-p':
                walk(stack, [name], parent, create=True)
            else:
                os.mkdir(name, mode=0o700, dir_fd=parent)
        elif command == 'rm':
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid:
                raise Rejected('PATH_DENIED')
            os.unlink(name, dir_fd=parent)
        else:
            source = regular_file(stack, parent, name)
            if command == 'cp':
                dest_parent, dest = parents[1]
                copy_new_file(source, dest_parent, dest)
            else:
                if command == 'tail':
                    source.seek(max(0, os.fstat(source.fileno()).st_size - LIMIT))
                data = source.read(LIMIT)
                if command == 'head':
                    data = b''.join(data.splitlines(True)[:lines])
                elif command == 'tail':
                    data = b''.join(data.splitlines(True)[-lines:])
                sys.stdout.buffer.write(data)


def fail(message):
    sys.stderr.buffer.write((message + '\n').encode('utf-8'))
    sys.exit(1)


if __name__ == '__main__':
    try:
        execute(sys.argv[1], sys.argv[2], sys.argv[3:])
    except Rejected as error:
        advice = {
            'USER_MISMATCH': '当前账号不符合运行身份要求，请联系平台管理员。',
            'ARGUMENT_DENIED': '文件命令的参数不符合要求，请检查选项和路径数量。',
            'PATH_DENIED': '该路径不允许操作，请在个人家目录或个人临时目录内选择符合要求的路径。',
        }
        fail('根据安全管理规范，文件操作已拦截。' + advice[str(error)])
    except FileExistsError:
        fail('目标已存在。为避免覆盖，请指定一个新的目标路径。')
    except OSError:
        fail('无法访问指定路径。请确认路径存在、有访问权限，并且未使用符号链接。')
