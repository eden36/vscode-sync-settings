#!/usr/bin/env python3
"""本地打包并安装 My Setting Sync 扩展到 VS Code / Cursor（仅供个人本机使用，不经过 Marketplace）。"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

# python scripts/install_local.py                  安装到 VS Code
# python scripts/install_local.py --editor cursor  安装到 Cursor

if sys.platform == "win32":
    # Windows 控制台默认代码页可能不是 UTF-8，不修正会导致中文输出乱码。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VSIX_OUTPUT_DIR = PROJECT_ROOT / "tmp" / "vsix-output"

# 编辑器命令行入口对应的显示名称，同时作为 --editor 的可选值。
EDITOR_DISPLAY_NAME = {
    "code": "VS Code",
    "code-insiders": "VS Code Insiders",
    "cursor": "Cursor",
}

# 默认 Profile 的扩展记录位于用户主目录下的编辑器数据目录（如 ~/.vscode/extensions/extensions.json）。
EDITOR_HOME_FOLDER = {
    "code": ".vscode",
    "code-insiders": ".vscode-insiders",
    "cursor": ".cursor",
}

# Profile 列表与工作区关联记录在 <用户数据目录>/<目录>/User/globalStorage/storage.json。
EDITOR_USER_DATA_FOLDER = {
    "code": "Code",
    "code-insiders": "Code - Insiders",
    "cursor": "Cursor",
}
DEFAULT_PROFILE_ID = "__default__profile__"


def run(command: list[str]) -> None:
    print(f"[执行] {subprocess.list2cmdline(command)}")
    result = subprocess.run(command, cwd=PROJECT_ROOT)
    if result.returncode != 0:
        raise SystemExit(f"命令执行失败（退出码 {result.returncode}）：{subprocess.list2cmdline(command)}")


def resolve_command(name: str) -> str:
    """解析命令的完整路径；Windows 下 code / cursor / npx 都是 .cmd，需要借助 PATH 查找。"""
    resolved = shutil.which(name)
    if not resolved:
        raise SystemExit(f"未在 PATH 中找到命令：{name}。请确认已安装，并已把命令行入口加入 PATH。")
    return resolved


def read_extension_id() -> str:
    data = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
    return f"{data['publisher']}.{data['name']}"


def package_vsix() -> Path:
    VSIX_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in VSIX_OUTPUT_DIR.glob("*.vsix"):
        old.unlink()
    # vsce package 会先执行 package.json 里的 vscode:prepublish（类型检查与测试，并带出构建），无需手动构建。
    run([resolve_command("npx"), "--yes", "vsce", "package", "--no-dependencies", "--out", str(VSIX_OUTPUT_DIR)])
    vsix_files = sorted(VSIX_OUTPUT_DIR.glob("*.vsix"))
    if not vsix_files:
        raise SystemExit("打包完成但未找到生成的 .vsix 文件。")
    return vsix_files[-1]


def install_vsix(vsix_path: Path, editor_command: str, profile: str | None) -> None:
    command = [resolve_command(editor_command), "--install-extension", str(vsix_path), "--force"]
    if profile:
        command += ["--profile", profile]
    run(command)


def user_data_root(editor_command: str) -> Path:
    """返回编辑器的用户数据目录（含 User 子目录的上一级）。"""
    folder = EDITOR_USER_DATA_FOLDER[editor_command]
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            raise SystemExit("未找到 APPDATA 环境变量，无法读取 Profile 列表。")
        return Path(appdata) / folder
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / folder
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / folder


def read_storage(editor_command: str) -> dict:
    path = user_data_root(editor_command) / "User" / "globalStorage" / "storage.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"无法解析 Profile 列表：{path}（{error}）") from error
    return data if isinstance(data, dict) else {}


def current_profile(storage: dict) -> str | None:
    """返回本项目工作区关联的 Profile 名称，None 表示默认 Profile。"""
    workspace_uri = ("file:///" + PROJECT_ROOT.as_posix()).lower()
    associations = storage.get("profileAssociations", {}).get("workspaces", {})
    location = next(
        (profile_id for uri, profile_id in associations.items() if unquote(uri).lower() == workspace_uri),
        DEFAULT_PROFILE_ID,
    )
    for profile in storage.get("userDataProfiles", []):
        if profile.get("location") == location and not profile.get("useDefaultFlags", {}).get("extensions"):
            return profile.get("name")
    return None


def profile_extension_paths(editor_command: str, storage: dict) -> tuple[Path, list[Path]]:
    """返回默认 Profile 及独立 Profile 的扩展记录文件路径。"""
    default_path = Path.home() / EDITOR_HOME_FOLDER[editor_command] / "extensions" / "extensions.json"
    profile_root = user_data_root(editor_command) / "User" / "profiles"
    profile_paths = [
        profile_root / profile["location"] / "extensions.json"
        for profile in storage.get("userDataProfiles", [])
        if profile.get("location") != DEFAULT_PROFILE_ID
    ]
    return default_path, profile_paths


def is_extension_record(item: object, extension_id: str) -> bool:
    if not isinstance(item, dict) or not isinstance(item.get("identifier"), dict):
        return False
    identifier = item["identifier"].get("id")
    return isinstance(identifier, str) and identifier.lower() == extension_id.lower()


def write_json_with_backup(path: Path, data: object) -> None:
    backup_path = path.with_suffix(path.suffix + ".bak")
    if not backup_path.exists():
        shutil.copy2(path, backup_path)
        print(f"[备份] 已备份原文件到 {backup_path}")
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(path)


def apply_extension_to_all_profiles(editor_command: str, storage: dict, extension_id: str) -> None:
    """将默认 Profile 中的扩展标记为应用级扩展，并移除各独立 Profile 里的旧安装记录。"""
    default_path, profile_paths = profile_extension_paths(editor_command, storage)
    if not default_path.exists():
        raise SystemExit(f"未找到默认 Profile 的扩展记录：{default_path}")

    try:
        default_extensions = json.loads(default_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise SystemExit(f"无法解析默认 Profile 的扩展记录：{default_path}（{error}）") from error
    if not isinstance(default_extensions, list):
        raise SystemExit(f"默认 Profile 的扩展记录格式不正确：{default_path}")

    extension = next((item for item in default_extensions if is_extension_record(item, extension_id)), None)
    if extension is None:
        raise SystemExit(f"默认 Profile 中未找到刚安装的扩展：{extension_id}")
    metadata = extension.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        raise SystemExit(f"默认 Profile 的扩展元数据格式不正确：{default_path}")
    if metadata.get("isApplicationScoped") is not True:
        metadata["isApplicationScoped"] = True
        write_json_with_backup(default_path, default_extensions)
        print("[完成] 已将扩展标记为应用于所有 Profile。")

    for profile_path in profile_paths:
        if not profile_path.exists():
            continue
        try:
            extensions = json.loads(profile_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise SystemExit(f"无法解析 Profile 扩展记录：{profile_path}（{error}）") from error
        if not isinstance(extensions, list):
            raise SystemExit(f"Profile 扩展记录格式不正确：{profile_path}")
        updated_extensions = [item for item in extensions if not is_extension_record(item, extension_id)]
        if len(updated_extensions) != len(extensions):
            write_json_with_backup(profile_path, updated_extensions)
            print(f"[完成] 已移除 Profile 的旧独立安装记录：{profile_path}")


def profile_label(profile: str | None) -> str:
    return profile if profile else "默认"


def ask_scope(current: str | None) -> str:
    print("请选择安装范围：")
    print(f"  1) 当前 Profile（{profile_label(current)}）")
    print("  2) 所有 Profile")
    while True:
        try:
            choice = input("请输入 1 或 2（直接回车为 1）：").strip() or "1"
        except EOFError:
            return "current"
        if choice in ("1", "2"):
            return "current" if choice == "1" else "all"
        print("输入无效，请输入 1 或 2。")


def main() -> None:
    parser = argparse.ArgumentParser(description="打包并安装 My Setting Sync 扩展到本机 VS Code / Cursor（个人使用）")
    parser.add_argument(
        "--editor",
        default="code",
        choices=sorted(EDITOR_DISPLAY_NAME),
        help="目标编辑器命令，默认 code；Cursor 用 cursor",
    )
    parser.add_argument("--vsix", type=Path, default=None, help="跳过打包，直接安装指定的 .vsix 文件")
    parser.add_argument(
        "--scope",
        choices=["current", "all"],
        default=None,
        help="安装范围：current 为本项目关联的 Profile，all 为所有 Profile；不传时运行中询问",
    )
    args = parser.parse_args()

    extension_id = read_extension_id()
    print(f"[信息] 扩展 ID：{extension_id}")
    print(f"[信息] 目标编辑器：{EDITOR_DISPLAY_NAME[args.editor]}")

    storage = read_storage(args.editor)
    current = current_profile(storage)
    scope = args.scope or ask_scope(current)
    targets = [None] if scope == "all" else [current]
    if scope == "all":
        print("[信息] 将安装到默认 Profile，并设为应用于所有 Profile。")
        print("提示：请在运行前完全退出目标编辑器，避免扩展记录被同时改写。")
    else:
        print(f"[信息] 安装到 Profile：{'、'.join(profile_label(p) for p in targets)}")

    vsix_path = args.vsix if args.vsix else package_vsix()
    print(f"[信息] 使用 VSIX：{vsix_path}")

    for profile in targets:
        install_vsix(vsix_path, args.editor, profile)
        print(f"[完成] 已安装到 Profile：{profile_label(profile)}")

    if scope == "all":
        apply_extension_to_all_profiles(args.editor, storage, extension_id)

    print(f"提示：请重启或重新加载 {EDITOR_DISPLAY_NAME[args.editor]} 窗口使新版本生效。")


if __name__ == "__main__":
    main()
