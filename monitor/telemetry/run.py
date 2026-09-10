#!/usr/bin/env python3
"""Passive mounted-input telemetry. No downloads, sessions, or model calls."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import study_common
import tool_error_dashboard as dashboard
import tool_error_report as reporter
from data_fill import assert_no_symlink_components, check_source_root


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parser():
    p = reporter.parser()
    # Retain all reporting controls, replacing only mount/output plumbing.
    for action in list(p._actions):
        if action.dest in {'log_root', 'output'}:
            p._remove_action(action)
            for option in action.option_strings:
                del p._option_string_actions[option]
    p.add_argument('--input-root', required=True, type=Path)
    p.add_argument('--output-root', required=True, type=Path)
    p.add_argument('--run-name', required=True)
    p.set_defaults(include_clients=True)
    return p


def run(args):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}', args.run_name):
        raise ValueError('invalid run name')
    root = check_source_root(args.input_root)
    output = Path(os.path.abspath(args.output_root.expanduser()))
    assert_no_symlink_components(output, 'output')
    if not output.is_dir() or root == output or root in output.parents or output in root.parents:
        raise ValueError('unsafe mount roots')
    # Mount must be provisioned privately; never chmod the bucket root itself.
    if output.stat().st_mode & 0o077:
        raise ValueError('output root must be owner-only')
    target = output / args.run_name
    staging = output / ('.' + args.run_name + '.pending')
    if target.exists() or target.is_symlink() or staging.exists() or staging.is_symlink():
        raise ValueError('run already exists')
    old_root, old_dashboard = study_common.ALLOWED_LOCAL_ROOT, dashboard.ALLOWED_LOCAL_ROOT
    study_common.ALLOWED_LOCAL_ROOT = output
    dashboard.ALLOWED_LOCAL_ROOT = output
    try:
        study_common.checked_output(staging, overwrite=False)
        args.log_root, args.output = root, staging / 'report'
        reporter.run(args)
        dashboard.run(args.output, args.server_repo, staging / 'dashboard')
        manifest = json.loads((args.output / 'manifest.json').read_text())
        for name, expected in manifest['outputs_sha256'].items():
            if sha(args.output / name) != expected:
                raise ValueError('report hash mismatch')
        visual = json.loads((staging / 'dashboard/visualization-manifest.json').read_text())
        if sha(staging / 'dashboard/dashboard.html') != visual['dashboard_sha256']:
            raise ValueError('dashboard hash mismatch')
        hashes = {p.relative_to(staging).as_posix(): sha(p)
                  for p in sorted(staging.rglob('*')) if p.is_file()}
        code = {p.name: sha(p) for p in sorted(Path(__file__).parent.iterdir())
                if p.suffix in {'.py', '.html', '.json'} and not p.name.startswith('test_')}
        study_common.write_private(staging / 'publication.json', {
            'schema': 'passive-telemetry-publication-v1', 'outputs_sha256': hashes,
            'runtime_sha256': code, 'review_status': 'private_aggregate_unreviewed',
        })
        for name, expected in hashes.items():
            if sha(staging / name) != expected:
                raise ValueError('publication hash mismatch')
        publication_hash = sha(staging / 'publication.json')
        # Atomic directory rename on local POSIX filesystems, not necessarily FUSE.
        os.rename(staging, target)
        study_common.write_private(target / '.COMPLETE.pending', publication_hash + '\n')
        os.rename(target / '.COMPLETE.pending', target / 'COMPLETE')
        return target
    finally:
        study_common.ALLOWED_LOCAL_ROOT, dashboard.ALLOWED_LOCAL_ROOT = old_root, old_dashboard


def main():
    # Fixed diagnostics only: never echo source paths, values, or exceptions.
    try:
        os.umask(0o077)
        run(parser().parse_args())
    except Exception:
        print('Telemetry failed; check mount permissions, dates, provenance and unused run name.', file=sys.stderr)
        return 1
    print('Private aggregate run complete; review required before sharing.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
