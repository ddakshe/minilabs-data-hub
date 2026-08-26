#!/usr/bin/env python3
"""LOCAL_JOBS.md 를 읽어 로컬 전용 작업을 돌리고 결과를 남긴다.

작업 목록은 **문서가 곧 레지스트리다** — 형제 저장소들의 LOCAL_JOBS.md 안
```yaml 블록을 그대로 읽는다. 따로 관리할 목록을 만들지 않는다.

결과는 local-jobs-status.json 에 쌓인다. 대시보드는 이 파일만 읽으면 되므로
"실행 버튼" 같은 위험한 엔드포인트를 만들 필요가 없다.
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

HUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE = os.path.dirname(HUB)
STATUS = os.path.join(HUB, 'local-jobs-status.json')
KST = timezone(timedelta(hours=9))


def parse_block(text):
    out, list_key = {}, None
    for raw in text.split('\n'):
        line = raw.rstrip()
        if not line.strip() or line.strip().startswith('#'):
            continue
        m = re.match(r'^\s+-\s+(.*)$', line)
        if m and list_key:
            out[list_key].append(re.sub(r'\s+#.*$', '', m.group(1)).strip())
            continue
        kv = re.match(r'^([A-Za-z_][\w-]*):\s*(.*)$', line)
        if not kv:
            continue
        key, rest = kv.group(1), kv.group(2)
        list_key = None
        if rest == '':
            out[key], list_key = [], key
        elif rest.startswith('['):
            out[key] = [s.strip() for s in rest.strip('[]').split(',') if s.strip()]
        else:
            out[key] = re.sub(r'\s+#.*$', '', rest).strip().strip('"\'')
    return out


def load_jobs():
    jobs, seen = [], set()
    for name in sorted(os.listdir(WORKSPACE)):
        d = os.path.join(WORKSPACE, name)
        f = os.path.join(d, 'LOCAL_JOBS.md')
        if not os.path.isfile(f):
            continue
        md = open(f, encoding='utf-8').read()
        for m in re.finditer(r'```ya?ml\n(.*?)```', md, re.S):
            j = parse_block(m.group(1))
            if not j.get('id') or not j.get('command'):
                continue
            if j['id'] in seen:
                print(f"⚠ id 중복 {j['id']} ({name}) — 건너뜁니다")
                continue
            seen.add(j['id'])
            j['repoDir'] = d
            j['repo'] = j.get('repo') or name
            jobs.append(j)
    return jobs


def field_match(field, value):
    """cron 한 필드가 값에 걸리는지. '*' · '3' · '1-5' · '1,3' 만 다룬다 (스텝 '*/2' 는 미지원)."""
    field = field.strip()
    if field == '*':
        return True
    for chunk in field.split(','):
        chunk = chunk.strip()
        if '-' in chunk:
            a, b = (int(x) for x in chunk.split('-'))
            if a <= value <= b:
                return True
        elif chunk.isdigit() and int(chunk) == value:
            return True
    return False


def due_today(job, now):
    """오늘 자동으로 잡히는 작업인지.

    'daily' 는 매일, 'on-demand' 는 자동 실행 안 함, 5필드 cron 은 **월·일·요일**을 본다
    (시·분은 러너가 하루 단위라 무시한다).

    🔴 **예전에는 요일 필드만 읽었다.** 월·일을 무시해서 `0 10 15 4 *`(4월 15일)라고 써도
       요일이 `*` 라 매일 due 가 됐다. 계절성 작업(사업보고서·연말정산처럼 한 해에 몇 번만
       도는 것)을 표현할 방법이 아예 없었다. 기존 항목은 월·일이 `*` 라 동작이 그대로다.

    ⚠️ **일(dom)과 요일(dow)을 둘 다 제한하면 여기서는 AND 다.** POSIX cron 은 OR 이라
       (`0 0 13 * 5` = 13일 **또는** 금요일) 다르다. 둘을 함께 쓰지 말 것.

    ⚠️ 해석하지 못하는 값(`quarterly` 같은 자유 문구)은 **True 로 떨어진다** — 즉 매일 due 다.
       자동으로 잡히지 않게 하려면 반드시 `on-demand` 라고 적는다.
    """
    sched = (job.get('schedule') or '').strip()
    if not sched or sched == 'on-demand':
        return False
    if sched.startswith('daily'):
        return True
    if sched.startswith('weekly'):
        return now.weekday() in (2, 3)     # 수·목 (기존 OTT 관행)
    parts = sched.split()
    if len(parts) == 5:
        _, _, dom, mon, dow = parts
        if not field_match(mon, now.month):
            return False
        if not field_match(dom, now.day):
            return False
        return field_match(dow, (now.weekday() + 1) % 7)   # 일=0
    return True


def ran_ok_today(job, status, now):
    """오늘 이미 성공했는지.

    cron 은 하루 한 번이라 필요 없었지만, 스킬은 사람이 부를 때마다 돈다.
    두 번 부르면 인증중고차를 5분씩 두 번 돌린다. 이름을 직접 지목하거나
    --all·--force 를 주면 이 검사를 건너뛴다.
    """
    rec = (status.get('jobs') or {}).get(job['id'])
    if not rec or not rec.get('ok'):
        return False
    return str(rec.get('ranAt', ''))[:10] == now.strftime('%Y-%m-%d')


def load_status():
    try:
        return json.load(open(STATUS, encoding='utf-8'))
    except Exception:
        return {'jobs': {}}


def save_status(st):
    st['updatedAt'] = datetime.now(KST).isoformat(timespec='seconds')
    with open(STATUS, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)


def run(job, status):
    print(f"\n▶ {job['id']} ({job['repo']}) — {job['command']}", flush=True)
    started = time.time()

    # 출력을 **흐르는 대로** 내보낸다.
    #
    # capture_output=True 로 받으면 끝날 때까지 0바이트다. 인증중고차는 5분이 걸리는데
    # 그동안 진행 로그가 안 보이면 "멈춘 것"과 "도는 중"을 구분할 방법이 없다.
    # 실제로 BMW 수집이 26분간 정지했는데 출력이 묶여 있어서 한참 못 알아챘다.
    # Claude 로 돌릴 때 특히 중요하다 — 판단 근거가 없으면 기다릴지 죽일지를 잘못 정한다.
    p = subprocess.Popen(job['command'], cwd=job['repoDir'], shell=True,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, bufsize=1)
    out = []
    for line in p.stdout:
        line = line.rstrip()
        out.append(line)
        print('   ', line, flush=True)
    p.wait()
    out = out or ['(출력 없음)']
    ok = p.returncode == 0
    status['jobs'][job['id']] = {
        'repo': job['repo'],
        'command': job['command'],
        'schedule': job.get('schedule', ''),
        'reason': job.get('reason', ''),
        'consumers': job.get('consumers', []),
        'ranAt': datetime.now(KST).isoformat(timespec='seconds'),
        'exitCode': p.returncode,
        'ok': ok,
        'seconds': round(time.time() - started, 1),
        'tail': out[-12:],
    }
    print(f"   {'✅' if ok else '❌'} exit={p.returncode} · {time.time() - started:.0f}초")
    return ok


def main():
    args = [a for a in sys.argv[1:]]
    jobs = load_jobs()
    if '--list' in args:
        for j in jobs:
            print(f"  {j['id']:<12}{j['repo']:<20}{j.get('schedule',''):<14}{j['command']}")
        return 0
    now = datetime.now(KST)
    status = load_status()
    named = [a for a in args if not a.startswith('--')]
    force = '--all' in args or '--force' in args

    if named:
        picked = [j for j in jobs if j['id'] in named]
        unknown = [n for n in named if not any(j['id'] == n for j in jobs)]
        if unknown:
            print(f"⚠ 그런 id 가 없습니다: {', '.join(unknown)} (--list 로 목록)")
        if not picked:
            return 1
    else:
        due = [j for j in jobs if force or due_today(j, now)]
        picked = due if force else [j for j in due if not ran_ok_today(j, status, now)]
        skipped = [j['id'] for j in due if j not in picked]
        if skipped:
            print(f"· 오늘 이미 성공 → 건너뜀: {', '.join(skipped)} (--force 로 다시 실행)")
        if not picked:
            print('오늘 돌릴 작업이 없습니다. (--force 로 다시 실행, --list 로 목록)')
            return 0
    print(f"{now:%Y-%m-%d %H:%M} KST · {len(picked)}개 실행")
    failed = [j['id'] for j in picked if not run(j, status)]
    save_status(status)
    print(f"\n{'❌ 실패: ' + ', '.join(failed) if failed else '✅ 전부 성공'}")
    print(f"상태: {os.path.relpath(STATUS, HUB)}")
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
