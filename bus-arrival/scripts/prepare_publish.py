#!/usr/bin/env python3
"""Stamp publication preparation, NOT actual GitHub Pages availability."""
import datetime as dt
import json
from pathlib import Path


def prepare(path, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    p = Path(path)
    data = json.loads(p.read_text(encoding='utf-8'))
    data['publish_prepared_at'] = now.isoformat()
    poll = dt.datetime.fromisoformat(data['last_poll'])
    data['poll_to_publish_prepare_sec'] = max(0, round((now-poll).total_seconds(), 3))
    data['publication_stage'] = 'prepared_not_deployed'
    tmp = p.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    tmp.replace(p)


if __name__ == '__main__':
    prepare('bus-arrival/status.json')
