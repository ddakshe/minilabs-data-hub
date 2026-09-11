# 동네별 무단투기 신고포상금 수집 안내

「신고하고 포상금받자」 미니앱의 동네 시트가 이 폴더를 읽는다.
`regions/{code}.json` 이 생기는 순간 **앱 재배포 없이** 그 동네에 금액·상한·기한이 보인다.
그래서 **틀린 값 하나가 바로 사용자에게 간다** — 모르면 null, 추측 금지.

샘플 3곳을 먼저 읽어라. 세 가지 형태를 하나씩 보여준다.

| 파일 | 형태 |
|---|---|
| `regions/41110.json` 수원시 | 과태료의 20% (method `rate`) · 포상금이 **별도 과태료 조례**에 있다 |
| `regions/11680.json` 강남구 | 금액표가 한글 별표뿐 (method `table`, `tableOnly`) · 월 상한 |
| `regions/51720.json` 홍천군 | 조례(기한·증거) + **시행규칙**(금액·자격)에 나뉘어 있다 |

---

## 0. 준비 (한 번)

```bash
H=~/ClaudeProjects/minilabs-data-hub
git -C $H fetch origin main
git -C $H worktree add --detach ~/rr-hub origin/main   # ⚠ 원래 폴더는 다른 작업이 다른 브랜치로 쓰는 중일 수 있다
cd ~/rr-hub
echo "LAW_OC=<국가법령정보 인증키>" >> .env           # .env 는 gitignore. 키는 ~/ClaudeProjects/assets-and-api-keys.md
```

- **국내 IP 에서** 돌린다(해외 IP 는 막힐 수 있다).
- 이미 워크트리가 있으면 `git -C ~/rr-hub pull --rebase origin main` 만 한다.

## 1. 원문 재료 받기

```bash
node scripts/collect-report-reward.mjs --sido 서울특별시     # 또는 --code 11740,11710
cat report-reward/_work/_summary.txt
```

- `report-reward/_work/{code}.json` 에 후보 조례·규칙과 **포상금 조문 원문**, 포상금 별표 링크가 쌓인다(커밋 안 됨).
- 이미 `regions/{code}.json` 이 있는 곳은 건너뛴다. 다시 받으려면 `--force`.
- 시도 이름은 `realestate/region-master.json` 의 표기 그대로다(`전남광주통합특별시`, `강원특별자치도` …).
- 권장 순서: 서울 → 경기 → 인천·광역시 → 도. 한 번에 20~30곳씩.

`hint` 로 할 일이 갈린다:

| hint | 뜻 | 할 일 |
|---|---|---|
| `reward-found` | 포상금 조문이 있는 법규를 찾았다 | 2단계 |
| `no-reward-article` | 폐기물 법규는 있는데 포상금 조문이 안 걸렸다 | 3단계(없다 판정 전 확인) |
| `no-ordinance` | 후보가 하나도 없다 | 3단계 |

## 2. `regions/{code}.json` 채우기

`_work/{code}.json` 의 `articles[].text`·`tables[]` 를 **읽고** 아래 스키마로 쓴다. 파일명 = code.
`code·sido·sigungu` 는 `_work` 파일의 값을 그대로 쓴다(일반구는 이미 모시로 묶여 있다).

| 필드 | 규칙 |
|---|---|
| `status` | `verified` — 포상금 규정을 확인했다 · `none` — 제도가 없다고 확인했다 (`stale` 은 월간 감지가 붙인다, 직접 쓰지 않는다) |
| `dumping.method` | `rate` 과태료의 n% · `fixed` 건당 고정액 · `table` 품목별 금액표 |
| `dumping.rates` | `rate` 일 때만. `[{item, rate}]`, **20% → 0.2**. 품목별 차등이면 행을 나눈다(`일반` 0.5 / `담배꽁초` 0.2 / `음식물` 0.1) |
| `dumping.fixedWon` | `fixed` 일 때만. 원 단위 정수 |
| `dumping.examples` | 금액표에서 읽은 대표 금액 `[{item, fineWon, rewardWon}]`. 못 읽었으면 null |
| `dumping.tableOnly` | 금액이 한글 별표에만 있고 **못 열었으면** true (앱은 「금액표 원문 보기」만 보여준다) |
| `dumping.caps` | `monthWon` `yearWon` `monthCount` `yearCount` — 없으면 null, **0 금지**. 단위가 특이하면(세대당, 유형별 연 2건) 숫자 대신 `note` 에 문장으로 |
| `dumping.deadlineDays` | 「적발일부터 14일 이내」 → 14. 규정이 없으면 null |
| `dumping.residency` | 주민 자격(「신고일 6개월 전부터 ○○군에 주민등록」). 제한 없으면 null |
| `dumping.payment` | 지급 수단 원문 요약(현금·지역화폐·종량제봉투…). 없으면 null |
| `dumping.channels` | 신고 방법이 조문에 있으면(서식 제출, 사진·영상 필수, 안전신문고 인정 등). 없으면 null |
| `dumping.exclusions` | 지급 제외 사유를 짧은 문장 배열로. 없으면 null |
| `sources[]` | **읽은 법규마다 하나.** `_work` 의 `title·kind·ordinId·mst·promulgatedAt·url` 을 **복사**하고 `articles` 에 조문 번호(`제10조`, `별표 3`)를 적는다. `ordinId·mst` 는 월간 개정 감지의 기준이라 틀리면 안 된다 |
| `note` | 한두 문장, 사용자에게 필요한 사실만. 조례 구조 설명(「별도 과태료 조례에 있다」)은 쓰지 않는다 — 그건 `sources` 가 보여준다. 말투는 아래 「앱에 보이는 문장」 규칙 |
| `checkedAt` | 오늘(KST) |

**앱에 보이는 문장 — 전부 해요체** (2026-09-11 추가)
앱은 아래 문자열을 **가공하지 않고 그대로** 화면에 보여준다. 조문의 「…해야 한다」「…할 수 있다」를 그대로 옮기지 말고 사용자에게 말하듯 바꾼다.
`note` · `caps.note` · `examples[].item` · `rates[].item` · `residency` · `payment[]` · `channels[]` · `exclusions[]`

| ❌ 조문 말투 | ✅ 앱 문장 |
|---|---|
| 위반행위일부터 1개월 이내에 신고해야 한다 | 위반을 본 날부터 1개월 안에 신고해야 해요 |
| 전화·방문·서면으로 신고할 수 있다 | 전화·방문·서면으로 신고할 수 있어요 |
| 행위자의 인적사항과 위반내역을 정확히 신고해야 한다 | 버린 사람의 인적사항과 위반 내용을 정확히 알려야 해요 |
| 담배꽁초, 휴지 등 폐기물을 버리는 행위 | 담배꽁초·휴지 등을 버린 경우 |

- `examples[].item`·`rates[].item` 은 표의 한 줄 이름이라 **짧게**(20자 안팎). 조문의 긴 괄호 설명은 뺀다.
- 이미 올린 동네도 이 규칙에 맞게 고쳐 다시 커밋한다(검증 스크립트는 말투를 잡지 못한다 — 눈으로 본다).

**판단 요령**
- 조례가 「규칙으로 정한다」고 넘기면 **규칙까지 봐야** 금액·자격이 나온다(홍천). 둘 다 `sources` 에 넣는다.
- 과태료 조례·신고포상금 조례가 따로 있는 곳이 많다(수원·경기 광주·구리). 폐기물 조례에 없다고 끝내지 않는다.
- 광역시 조례(「서울특별시 …」)의 조문은 **구 단위 값으로 쓰지 않는다** — 구 조례가 따로 있다.
- 무단투기가 아닌 포상금(불법소각만, 음식물 재활용 우수 포상 등)은 넣지 않는다. 조문에 투기·무단 버림 신고가 있어야 한다.
- 조문이 **법 조항 번호로만** 대상을 가리켜도(「법 제8조제1항 또는 제2항의 위반행위를 신고한 자」) 무단투기 포상금이다 — 폐기물관리법 제8조가 무단투기 금지다(남양주·고양·하남).
- 「포상금」이 아니라 **「보상금」**이라고 쓰는 조례도 있다(오산). 별표 제목이 그냥 「별표」「별표 3」이어도 조문이 가리키면 그 표다.
- 한도 단위가 스키마에 없으면(분기 10건, 구청별 월 10건) 숫자 칸을 비우거나 맞는 칸만 채우고 **`caps.note` 에 문장으로** 쓴다.
- 「과태료의 80% 이내」처럼 **상한만 있는 비율**은 `rates[].item` 에 「이내」를 남긴다(앱이 「최대 80%」로 보여준다).
- 조문이 말하지 않는 건 null. 구청 홈페이지 안내와 다르면 **조례·규칙을 따르고** 차이를 `note` 에.

**금액표(한글 별표) 열기 — 선택**
`tables[].fileUrl` 이 hwp 다. 열 수 있으면 `examples` 를 채우고 `tableOnly: false`.
```bash
python3 -m venv ~/.venv-hwp && ~/.venv-hwp/bin/pip install pyhwp six     # six 가 없으면 import 에서 죽는다
curl -sL "<fileUrl>" -o /tmp/t.hwp && ~/.venv-hwp/bin/hwp5html --output /tmp/t.html /tmp/t.hwp
# 표는 /tmp/t.html 의 <table> 에서 읽는다. ⚠ hwp5txt 는 표를 「<표>」 한 글자로 버려서 금액을 못 읽는다
```
안 열리면 `tableOnly: true` 로 두고 넘어간다. 멈추지 않는다.

## 3. 「없다」 판정 (`no-reward-article` · `no-ordinance`)

`status: none` 은 앱에 「이 동네는 포상금 제도가 없어요」로 보인다. **확인 없이 쓰지 않는다.**
1. `_work` 후보 중 폐기물 관리 조례·시행규칙 본문을 직접 열어 「포상」을 찾는다(`url`).
2. 국가법령정보센터에서 「{지자체명} 과태료」「{지자체명} 신고포상금」을 검색해 본다.
3. 그래도 없으면 `status: none`, `dumping: null`, `sources` 에 **확인한 법규들**(articles 는 `[]`), `note` 에 「폐기물 관리 조례·시행규칙·과태료 조례에 무단투기 신고포상금 조항 없음」.
4. 애매하면 **파일을 만들지 않는다**(앱은 「원문 찾아보기」 링크를 보여준다). 틀린 `none` 보다 낫다.

## 4. 검증

```bash
node scripts/build-report-reward.mjs
```
- 실패하면 메시지대로 고친다. **실패한 채로 커밋하지 않는다.**
- 통과하면 `regions/index.json`·`meta.json` 이 다시 만들어진다(함께 커밋).

## 5. 커밋·푸시

```bash
git add report-reward/regions report-reward/meta.json
git commit -m "data(report-reward): 서울 25구 무단투기 신고포상금"
git pull --rebase origin main
git push origin HEAD:refs/heads/main
echo $?                                   # 0 이어야 한다
git ls-remote origin refs/heads/main      # 원격 해시가 방금 커밋과 같은지
```
- `report-reward/` 밖의 파일은 커밋하지 않는다.
- ⚠ `git push … | tail` 처럼 파이프로 감싸지 않는다 — 실패해도 성공처럼 보인다.

## 6. 조례가 바뀌었을 때 (월간 감지 이후)

월간 워크플로가 `sources[].ordinId` 의 현행 `mst` 가 바뀐 곳을 `status: stale` 로 바꾸고 이슈를 연다.
이슈에 적힌 code 만 `node scripts/collect-report-reward.mjs --code … --force` → 2단계 → `status: verified`, `staleSince` 삭제 → 4·5단계.
