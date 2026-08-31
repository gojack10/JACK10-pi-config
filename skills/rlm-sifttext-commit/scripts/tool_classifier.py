#!/usr/bin/env python
import re
from pathlib import Path

READ_TOOLS = {'read', 'get_current_session', 'sifttext_get_node', 'sifttext_get_outline', 'sifttext_sql'}
STATE_TOOLS = {
    'write', 'edit', 'sifttext_create_tree', 'sifttext_create_node',
    'sifttext_crystallize_append', 'sifttext_crystallize_replace',
    'sifttext_edit_crystallization', 'sifttext_edit_section', 'sifttext_edit_scope',
    'sifttext_set_scope', 'sifttext_resolve', 'sifttext_mark_stuck', 'sifttext_discard',
    'sifttext_defer', 'sifttext_activate', 'sifttext_set_priority', 'sifttext_link_by_name',
    'sifttext_add_warning', 'sifttext_add_ruled_out', 'sifttext_set_vitals',
    'sifttext_rename_node', 'sifttext_move_node', 'sifttext_move_cross_tree',
    'sifttext_reorder_children', 'sifttext_promote_to_root', 'sifttext_delete_node',
    'sifttext_duplicate_node',
}
STATE_SHELL = re.compile(
    r'(^|[;&|]\s*)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|install)\b|'
    r'\bsed\s+-[^\n;]*i\b|\bperl\s+-[^\n;]*i\b|\btee\b|'
    r'\bgit\s+(add|commit|push|reset|revert|checkout|switch|restore|merge|rebase|cherry-pick|clean)\b|'
    r'(^|[;&|]\s*)(systemctl|launchctl|nixos-rebuild|home-manager|hms)\b|'
    r'\b(docker|podman)\s+(run|rm|stop|start|restart|exec|compose)\b|'
    r'\b(curl|wget)\b[^\n;]*(--data|-d\s|-X\s*(POST|PUT|PATCH|DELETE))|'
    r'\b(make|just|task)\s+(install|deploy|release)\b', re.I)
TRANSIENT_SHELL = re.compile(
    r'\btmux\s+(new-|kill-|move-|rename-|set-|load-buffer|paste-buffer|send-keys|pipe-pane|wait-for)|'
    r'(^|\s)(mktemp|sleep|wait|kill)\b|>>?\s*/tmp/', re.I)
CUSTOM_EXECUTABLE = re.compile(r'(^|[;&|]\s*|\s|["\'])\./[^\s;|&]+')
SHELL_COMPLEX = re.compile(r'\b(sh|bash|zsh|python|python3|node|deno|bun|ruby|perl)\s+|`|\$\(|<<|\beval\b|\bxargs\b', re.I)
READ_SHELL_HEADS = {
    'cd', 'pwd', 'ls', 'rg', 'grep', 'find', 'fd', 'git', 'tmux', 'nix', 'head', 'tail',
    'wc', 'cat', 'stat', 'shasum', 'sha256sum', 'cut', 'sort', 'uniq', 'jq', 'type',
    'which', 'command', 'ps', 'lsof', 'test', '[', 'echo', 'printf', 'true', 'false', 'du',
}


def one_line(text, limit=700):
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text if len(text) <= limit else text[:limit] + '…'


def classify_shell(command):
    probe = re.sub(r'\d*>>?\s*(/dev/null|/tmp/[^\s;]+)', '', command)
    if STATE_SHELL.search(probe):
        return 'state_change'
    if CUSTOM_EXECUTABLE.search(probe):
        return 'unknown'
    if TRANSIENT_SHELL.search(command):
        return 'transient'
    if SHELL_COMPLEX.search(probe):
        return 'unknown'
    parts = [part.strip() for part in re.split(r'&&|\|\||;|\|', command) if part.strip()]
    for part in parts:
        words = part.split()
        while words and '=' in words[0] and not words[0].startswith(('./', '/')):
            words.pop(0)
        if not words:
            continue
        head = Path(words[0]).name
        if head not in READ_SHELL_HEADS:
            return 'unknown'
        if head == 'find' and any(flag in words for flag in ('-delete', '-exec', '-execdir')):
            return 'state_change'
        if head == 'git' and len(words) > 1 and words[1] not in {'status', 'diff', 'log', 'show', 'rev-parse', 'branch', 'remote', 'ls-remote', 'describe'}:
            return 'unknown'
        if head == 'tmux' and len(words) > 1 and not words[1].startswith(('list-', 'show-', 'display-', 'capture-')):
            return 'unknown'
        if head == 'nix' and len(words) > 1 and words[1] not in {'eval', 'path-info', 'log', 'flake'}:
            return 'unknown'
    return 'read_only'


def self_check():
    assert classify_shell('git status') == 'read_only'
    assert classify_shell('rg foo . 2>/dev/null | head') == 'read_only'
    assert classify_shell('git commit -m test') == 'state_change'
    assert classify_shell('hms') == 'state_change'
    assert classify_shell('tmux new-session -d -s probe') == 'transient'
    assert classify_shell('tmux new-session -d -s probe "git commit -m bad"') == 'state_change'
    assert classify_shell('tmux new-session -d -s probe "./deploy.sh"') == 'unknown'
    assert classify_shell('./custom-script') == 'unknown'
    print('tool classifier self-check PASS')


if __name__ == '__main__':
    self_check()
