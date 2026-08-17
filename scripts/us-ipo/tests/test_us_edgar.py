import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from us_edgar import dedupe_by_cik, document_url, hit_cik, hit_filed_at, hit_name, strip_html


def hit(cik, name, filed, acc='0001234567-26-000001', fname='doc.htm'):
    return {
        '_id': f'{acc}:{fname}',
        '_source': {'ciks': [cik], 'display_names': [name], 'file_date': filed},
    }


class TestHitAccessors:
    def test_필드를_꺼낸다(self):
        h = hit('0002110117', 'ITG, Inc. (ITG)', '2026-08-14')
        assert hit_cik(h) == '0002110117'
        assert hit_name(h) == 'ITG, Inc. (ITG)'
        assert hit_filed_at(h) == '2026-08-14'

    def test_비어_있어도_터지지_않는다(self):
        assert hit_cik({}) == ''
        assert hit_name({}) == ''
        assert hit_filed_at({}) == ''


class TestDedupe:
    def test_같은_cik_은_최신_제출건만_남긴다(self):
        """full-text search 는 같은 회사를 여러 번 준다 (실측: Janus, GSR V, Oceanhawk)."""
        hits = [
            hit('0001', 'Janus Living', '2026-07-01'),
            hit('0001', 'Janus Living', '2026-08-10'),
            hit('0002', 'ITG', '2026-08-14'),
        ]
        result = dedupe_by_cik(hits)
        assert len(result) == 2
        janus = next(h for h in result if hit_cik(h) == '0001')
        assert hit_filed_at(janus) == '2026-08-10'

    def test_순서를_유지한다(self):
        hits = [hit('0002', 'B', '2026-08-14'), hit('0001', 'A', '2026-08-10')]
        assert [hit_cik(h) for h in dedupe_by_cik(hits)] == ['0002', '0001']

    def test_cik_이_없는_항목은_버린다(self):
        assert dedupe_by_cik([{'_id': 'x:y', '_source': {}}]) == []


class TestDocumentUrl:
    def test_accession_의_하이픈을_제거하고_cik_의_0을_뗀다(self):
        h = hit('0002110117', 'ITG', '2026-08-14', '0001234567-26-000009', 'itg424b4.htm')
        assert document_url(h) == (
            'https://www.sec.gov/Archives/edgar/data/2110117/'
            '000123456726000009/itg424b4.htm'
        )


class TestStripHtml:
    def test_태그와_엔티티를_지운다(self):
        html = '<p>we are an &#8220;emerging&#8221; company</p><script>x=1</script>'
        out = strip_html(html)
        assert 'script' not in out
        assert 'x=1' not in out
        assert 'emerging' in out
        assert '<p>' not in out

    def test_공백을_한칸으로_접는다(self):
        assert strip_html('<b>a</b>\n\n   <i>b</i>') == 'a b'
