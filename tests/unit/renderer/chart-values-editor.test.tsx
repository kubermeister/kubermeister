import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChartValues } from '../../../src/shared/chart-values';
import { renderWithQuery } from './helpers';
import { WEB_DEFAULTS, webChart } from './values-schema-fixture';

const { ChartValuesEditor } = await import('@/components/chart/values-editor');
const { startCompletion, currentCompletions } = await import('@codemirror/autocomplete');
const { EditorView } = await import('@codemirror/view');

const chart: ChartValues = { valuesYaml: WEB_DEFAULTS, schema: webChart, schemaProblem: null, subcharts: [] };
const plain: ChartValues = { valuesYaml: 'replicaCount: 1\n', schema: null, schemaProblem: null, subcharts: [] };

const marked = (container: HTMLElement, severity: 'error' | 'warning') =>
    [...container.querySelectorAll(`.cm-lintRange-${severity}`)].map((mark) => mark.textContent);

const SCHEMA_FAILURE = [
    "values don't meet the specifications of the schema(s) in the following chart(s):",
    'web:',
    "- at '/image/tag': got number, want string",
].join('\n');

describe('the chart values editor', () => {
    it('starts from the values it is given and marks what the chart’s schema refuses', async () => {
        const { container } = renderWithQuery(
            <ChartValuesEditor chart={chart} value={'replicaCount: two\n'} onValueChange={() => {}} />,
        );
        await waitFor(() => expect(marked(container, 'error')).toEqual(['two']));
        expect(screen.getByRole('textbox', { name: 'Chart values' })).toBeInTheDocument();
    });

    it('checks a chart with no schema as plain YAML', async () => {
        const { container } = renderWithQuery(
            <ChartValuesEditor chart={plain} value={'replicaCount: two\nbad: a: b\n'} onValueChange={() => {}} />,
        );
        // The YAML's own error, and nothing about the value a schema would have refused.
        await waitFor(() => expect(marked(container, 'error')).toEqual(['a']));
        expect(screen.queryByTestId('values-schema-problem')).toBeNull();
    });

    it('says why a schema the chart ships is not used', () => {
        renderWithQuery(
            <ChartValuesEditor
                chart={{ ...plain, schemaProblem: 'The chart’s values.schema.json is not JSON.' }}
                value=""
                onValueChange={() => {}}
            />,
        );
        expect(screen.getByTestId('values-schema-problem')).toHaveTextContent(
            'The chart’s values.schema.json is not JSON. The values are checked as YAML only.',
        );
    });

    it('lays a refused render over the values it names, and drops it once the text changes', async () => {
        const values = 'image:\n  repository: nginx\n  tag: 1\n';
        const renderError = { values, message: SCHEMA_FAILURE };
        const { container, rerender } = renderWithQuery(
            <ChartValuesEditor chart={plain} value={values} onValueChange={() => {}} renderError={renderError} />,
        );
        await waitFor(() => expect(marked(container, 'error')).toEqual(['tag']));
        expect(screen.getByRole('alert')).toHaveTextContent(
            'The values do not match the chart’s schema. The values it names are marked below.',
        );
        rerender(
            <ChartValuesEditor
                chart={plain}
                value={'image:\n  repository: nginx\n  tag: "1"\n'}
                onValueChange={() => {}}
                renderError={renderError}
            />,
        );
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        await waitFor(() => expect(marked(container, 'error')).toEqual([]));
    });

    it('lists what a failed template names no value for, with its template and line', () => {
        const values = 'replicaCount: 1\n';
        renderWithQuery(
            <ChartValuesEditor
                chart={plain}
                value={values}
                onValueChange={() => {}}
                renderError={{
                    values,
                    message: 'execution error at (web/templates/ingress.yaml:12:5): a host is required',
                }}
            />,
        );
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('The chart did not render with these values.');
        expect(alert).toHaveTextContent('a host is required · web/templates/ingress.yaml, line 12');
        expect(alert).not.toHaveTextContent('marked below');
    });

    it('completes values from the chart’s schema', async () => {
        const text = 'image:\n  pull';
        const { container } = renderWithQuery(
            <ChartValuesEditor chart={chart} value={text} onValueChange={() => {}} />,
        );
        await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
        const view = EditorView.findFromDOM(container.querySelector('.cm-content') as HTMLElement)!;
        view.focus();
        view.dispatch({ selection: { anchor: text.length } });
        await waitFor(() => {
            startCompletion(view);
            return new Promise((resolve) => setTimeout(resolve, 150)).then(() =>
                expect(currentCompletions(view.state).map((option) => option.label)).toEqual(['pullPolicy']),
            );
        });
    });
});
