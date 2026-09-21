import { describe, expect, it } from 'vitest';
import { indexUrl, isChartIndexDocument, parseChartIndex, readCappedText } from '../../../src/main/charts/index-file';

const index = {
    apiVersion: 'v1',
    entries: {
        nginx: [
            { name: 'nginx', version: '18.2.0', appVersion: '1.27.1', description: 'A web server' },
            { name: 'nginx', version: '18.1.0', appVersion: '1.27.0', description: 'A web server' },
        ],
        redis: [{ name: 'redis', version: '20.0.1', appVersion: '7.4.0' }],
    },
};

describe('indexUrl', () => {
    it('appends the file Helm publishes, whatever trailing slashes the URL carries', () => {
        expect(indexUrl('https://charts.example.com')).toBe('https://charts.example.com/index.yaml');
        expect(indexUrl('https://charts.example.com/')).toBe('https://charts.example.com/index.yaml');
        expect(indexUrl('https://charts.example.com/sub///')).toBe('https://charts.example.com/sub/index.yaml');
    });
});

describe('parseChartIndex', () => {
    it('turns an index into one summary per chart, newest version first', () => {
        expect(parseChartIndex(index)).toEqual([
            {
                name: 'nginx',
                latestVersion: '18.2.0',
                appVersion: '1.27.1',
                description: 'A web server',
                versions: ['18.2.0', '18.1.0'],
            },
            { name: 'redis', latestVersion: '20.0.1', appVersion: '7.4.0', description: '', versions: ['20.0.1'] },
        ]);
    });

    it('sorts the charts by name, so the cached list does not depend on the map order', () => {
        const shuffled = { entries: { zeta: [{ version: '1.0.0' }], alpha: [{ version: '1.0.0' }] } };
        expect(parseChartIndex(shuffled).map((chart) => chart.name)).toEqual(['alpha', 'zeta']);
    });

    it('takes the chart name from the key, not from the entry, which may disagree', () => {
        const odd = { entries: { nginx: [{ name: 'something-else', version: '1.0.0' }] } };
        expect(parseChartIndex(odd)[0].name).toBe('nginx');
    });

    it('drops an entry with no usable version rather than inventing one', () => {
        const broken = {
            entries: {
                empty: [],
                nameless: [{ appVersion: '1' }],
                partial: [{ version: '2.0.0' }, { appVersion: 'x' }, { version: '1.0.0' }],
            },
        };
        expect(parseChartIndex(broken)).toEqual([
            { name: 'partial', latestVersion: '2.0.0', appVersion: '', description: '', versions: ['2.0.0', '1.0.0'] },
        ]);
    });

    it('answers an empty list for anything that is not an index', () => {
        for (const raw of [undefined, null, 'not yaml', 42, [], {}, { entries: [] }, { entries: { a: 'x' } }]) {
            expect(parseChartIndex(raw), JSON.stringify(raw)).toEqual([]);
        }
    });

    it('coerces fields that are present but not strings instead of failing the whole index', () => {
        const odd = { entries: { chart: [{ version: '1.0.0', appVersion: 7, description: { a: 1 } }] } };
        expect(parseChartIndex(odd)).toEqual([
            { name: 'chart', latestVersion: '1.0.0', appVersion: '', description: '', versions: ['1.0.0'] },
        ]);
    });
});

describe('readCappedText', () => {
    const OP = 'chartRepositories.refresh';

    it('reads a body that fits', async () => {
        await expect(readCappedText(OP, new Response('entries: {}\n'), 1024)).resolves.toBe('entries: {}\n');
    });

    it('stops reading a body that runs past the ceiling instead of holding all of it', async () => {
        const body = new Response('x'.repeat(64));
        await expect(readCappedText(OP, body, 16)).rejects.toMatchObject({ kind: 'invalid', op: OP });
    });

    it('refuses before reading anything when the answer announces it is too large', async () => {
        const response = new Response('short', { headers: { 'content-length': String(64) } });
        await expect(readCappedText(OP, response, 16)).rejects.toMatchObject({ kind: 'invalid' });
    });

    it('treats an answer with no body as empty', async () => {
        await expect(readCappedText(OP, new Response(null, { status: 204 }), 16)).resolves.toBe('');
    });
});

describe('isChartIndexDocument', () => {
    it('is true for a document shaped like an index, empty repository included', () => {
        expect(isChartIndexDocument({ apiVersion: 'v1', entries: {} })).toBe(true);
        expect(isChartIndexDocument(index)).toBe(true);
    });

    it('is false for anything else, so a login page served with a 200 is not read as an empty repository', () => {
        for (const raw of [undefined, null, '<html>404</html>', 42, [], {}, { entries: [] }, { entries: null }]) {
            expect(isChartIndexDocument(raw), JSON.stringify(raw)).toBe(false);
        }
    });
});
