#!/usr/bin/env python3
"""Check that collector and summary artifacts implement the same deployed contract."""
import argparse
import json
from pathlib import Path
from safety_model import timestamp


def validate(summary, status):
    errors = []
    if not isinstance(summary, dict) or not isinstance(status, dict):
        return ['Runtime artifacts must be JSON objects']
    for name, data in [('summary', summary), ('status', status)]:
        if data.get('runtime_schema_version') != 2:
            errors.append(f'{name}: runtime_schema_version must be 2')
    model = summary.get('safety_model') or {}
    if model.get('version') != 2 or 'model_status' not in model:
        errors.append('summary: safety model metadata missing')
    if timestamp(summary.get('generated_at')) is None:
        errors.append('summary: generation timestamp missing')
    if status.get('model_status') not in ('ready', 'unavailable', 'insufficient_support', 'invalid_training_date', 'retained_stale_margin'):
        errors.append('status: model readiness missing')
    if timestamp(status.get('api_response_received_at')) is None or timestamp(status.get('publish_prepared_at')) is None:
        errors.append('status: API/publication preparation timestamps missing')
    if status.get('current_veh_id') and not status.get('error'):
        safety = status.get('safety') or {}
        if timestamp(safety.get('safe_arrival_ts')) is None or safety.get('observation_ts') != status.get('last_poll'):
            errors.append('status: matching safety prediction missing')
    return errors


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--base', default='bus-arrival')
    args = p.parse_args()
    try:
        data = [json.loads((Path(args.base)/name).read_text()) for name in ('summary.json', 'status.json')]
        errors = validate(*data)
    except (OSError, ValueError) as e:
        errors = [f'Cannot inspect runtime artifacts: {type(e).__name__}']
    for error in errors:
        print(error)
    if not errors:
        print('Runtime schema 2 and safety model metadata verified; actual Pages delivery remains unmeasured.')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
