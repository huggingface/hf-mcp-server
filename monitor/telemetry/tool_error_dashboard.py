#!/usr/bin/env python3
"""Render offline visualization experiments from an existing private aggregate report."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess

from data_fill import assert_no_symlink_components
from study_common import ALLOWED_LOCAL_ROOT, checked_output, write_private
from tool_error_policy import BUCKETS, TOOL_OPERATIONS, FS_CODE_BUCKET, HTTP_BUCKETS
from tool_error_cohorts import CLIENT_FAMILIES, NUMERIC_VERSION, FS_ROOTS, FS_OPERATIONS

VERSION = re.compile(r'(?:unknown|\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z0-9.-]{1,30})?)\Z')
PUBLIC_REASONS = frozenset(FS_CODE_BUCKET) | {v[1] for v in HTTP_BUCKETS.values()} | {
    'unregistered_tool', 'structured_batch_errors', 'inconsistent_batch_call_outcome',
    'unsupported_shell_syntax', 'invalid_timeout_format', 'argument_validation', 'invalid_command',
    'handle_characters', 'invalid_handle', 'missing_handle_namespace', 'foreground_timeout_limit',
    'authentication_required', 'missing_path', 'unknown_operation', 'unmapped_http_status',
    'api_timeout', 'connection_failure', 'unrecognized_error', 'missing_error_evidence',
}
DAY = re.compile(r'\d{4}-\d{2}-\d{2}\Z')
DIMENSIONS = {'tool', 'day', 'day_version', 'operation', 'client', 'client_operation', 'fs_operation',
              'fs_command', 'fs_day_command', 'fs_client_command'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def releases(repo, start, end):
    """Git tag commit dates are provenance-backed proxies, NOT deploy/publish dates."""
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True, stderr=subprocess.DEVNULL).strip()
    result = []
    for tag in git('for-each-ref', '--format=%(refname:short)', 'refs/tags').splitlines():
        if not re.fullmatch(r'v\d{1,3}\.\d{1,3}\.\d{1,3}', tag):
            continue
        commit, instant = git('show', '-s', '--format=%H%x09%cI', tag+'^{}', '--').split('\t')
        day = datetime.fromisoformat(instant).astimezone(timezone.utc).date().isoformat()
        if start <= day <= end:
            result.append({'tag':tag, 'date':day, 'commit':commit, 'basis':'release-tag commit date (UTC)'})
    return sorted(result, key=lambda item: (item['date'], tuple(map(int,item['tag'][1:].split('.')))))


def valid_labels(dimension, labels, tool):
    if not isinstance(labels, list) or not all(isinstance(x,str) for x in labels):
        return False
    def op(x): return x in (*TOOL_OPERATIONS[tool], 'unknown')
    def cohort(values):
        return len(values)==2 and values[0] in CLIENT_FAMILIES and (values[1]=='unreported' or NUMERIC_VERSION.fullmatch(values[1]))
    if dimension=='tool': return labels==[]
    if dimension=='day': return len(labels)==1 and DAY.fullmatch(labels[0])
    if dimension=='day_version': return len(labels)==2 and DAY.fullmatch(labels[0]) and VERSION.fullmatch(labels[1])
    if dimension=='operation': return len(labels)==1 and op(labels[0])
    if dimension=='client': return cohort(labels)
    if dimension=='client_operation': return len(labels)==3 and op(labels[0]) and cohort(labels[1:])
    if dimension=='fs_operation': return len(labels)==2 and labels[0] in (*FS_OPERATIONS,'unknown') and labels[1] in FS_ROOTS
    if dimension=='fs_command': return tool=='hf_fs' and len(labels)==1 and op(labels[0])
    if dimension=='fs_day_command': return tool=='hf_fs' and len(labels)==2 and DAY.fullmatch(labels[0]) and op(labels[1])
    if dimension=='fs_client_command': return tool=='hf_fs' and len(labels)==3 and op(labels[0]) and cohort(labels[1:])
    return False


def compact(report, manifest):
    if report.get('schema')!='tool-error-report-v2' or not manifest.get('include_clients'):
        raise ValueError('v2 client-enabled report required')
    windows = {}
    for key, value in manifest['windows'].items():
        if key not in ('current','baseline'):
            raise ValueError('invalid window')
        dates = value['inclusive_event_dates']
        if len(dates)!=2 or not all(DAY.fullmatch(d) for d in dates):
            raise ValueError('invalid dates')
        windows[key] = {'dates':dates,'partial':value['partial_day'],
                        'client_coverage':{k:v for k,v in value['counts'].items() if k in ('registered_tool_calls','recognized_client_family_calls','numeric_client_version_calls')}}
    data = []
    for row in report['rows']:
        dim,tool = row['dimension'],row['tool']
        if dim not in DIMENSIONS:
            continue
        if tool not in TOOL_OPERATIONS or row['window'] not in windows or not valid_labels(dim,row['labels'],tool):
            raise ValueError('non-public label')
        counts = [row['calls'],row['failure'],row['unknown_outcome'],row['degraded_calls']]
        if not all(type(n) is int and n>=0 for n in counts) or counts[1]+counts[2]>counts[0] or not counts[1]<=counts[3]<=counts[0]:
            raise ValueError('invalid count')
        buckets = [row['failure_buckets'][b] for b in BUCKETS]
        if not all(type(n) is int and n>=0 for n in buckets) or sum(buckets)!=row['failure']:
            raise ValueError('non-reconciling buckets')
        reasons = []
        for reason in row['reasons']:
            if reason['bucket'] not in BUCKETS or reason['reason'] not in PUBLIC_REASONS or type(reason['count']) is not int or not 0<=reason['count']<=row['failure']:
                raise ValueError('invalid reason')
            reasons.append([reason['bucket'],reason['reason'],reason['count']])
        data.append({'w':row['window'],'d':dim,'t':tool,'l':row['labels'], 'n':counts[0], 'f':counts[1],
                     'u':counts[2],'degraded':counts[3],'b':buckets,'reasons':reasons,
                     'parents':row.get('batch',{}).get('contributing_batches',0)})
    return {'windows':windows,'rows':data,'buckets':list(BUCKETS),'policy':report['policy'],
            'client_floor':manifest['client_min_cell_count'], 'client_policy':manifest['client_policy']}


def render_html(payload, template):
    # Escape HTML/script delimiters even though all labels have already been validated.
    encoded = json.dumps(payload,separators=(',',':'),ensure_ascii=True).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    if template.count('__REPORT_DATA__')!=1:
        raise ValueError('invalid template')
    return template.replace('__REPORT_DATA__', encoded)


def run(report_dir, server_repo, output):
    source = report_dir.expanduser().absolute()
    if ALLOWED_LOCAL_ROOT is None or ALLOWED_LOCAL_ROOT not in source.parents:
        raise ValueError('explicit private root required')
    assert_no_symlink_components(source,'aggregate input')
    for name in ('report.json','manifest.json'):
        p = source/name
        assert_no_symlink_components(p,'aggregate input')
        if not p.is_file() or p.stat().st_size>30*1024*1024:
            raise ValueError('invalid aggregate input')
    manifest = json.loads((source/'manifest.json').read_text())
    if sha(source/'report.json') != manifest['outputs_sha256']['report.json']:
        raise ValueError('input hash mismatch')
    report = json.loads((source/'report.json').read_text())
    payload = compact(report,manifest)
    start=min(w['dates'][0] for w in payload['windows'].values())
    end=max(w['dates'][1] for w in payload['windows'].values())
    payload['releases'] = releases(server_repo,start,end)
    template = Path(__file__).with_suffix('.html')
    html = render_html(payload,template.read_text())
    target = checked_output(output,overwrite=False)
    write_private(target/'dashboard.html',html)
    write_private(target/'visualization-manifest.json',{
        'schema':'tool-error-dashboard-v1', 'run_date':datetime.now(timezone.utc).date().isoformat(),
        'report_sha256':sha(source/'report.json'),'report_manifest_sha256':sha(source/'manifest.json'),
        'renderer_sha256':sha(Path(__file__)),'template_sha256':sha(template),
        'dashboard_sha256':sha(target/'dashboard.html'), 'policy':payload['policy'],
        'release_calendar':payload['releases'], 'release_marker_caveat':'tag commit dates, not publication or deployment dates',
        'review_status':'private_aggregate_unreviewed','network':'none; HTML has no external assets or requests',
        'views':['pulse','cohorts','opportunities','filesystem'], 'source_window_dates':{k:v['dates'] for k,v in payload['windows'].items()},
    })
    print('Offline dashboard written; four views, source hashes and release-marker provenance recorded.')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--report',type=Path,required=True)
    p.add_argument('--server-repo',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    try:
        run(args.report,args.server_repo,args.output)
    except Exception:
        raise SystemExit('Dashboard failed; check aggregate input, hashes, server repo and output path. No source details emitted.') from None
