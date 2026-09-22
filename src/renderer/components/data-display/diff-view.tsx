import { diffLines, hasChanges, type DiffLine } from '@/lib/line-diff';
import { cn } from '@/lib/utils';

/**
 * Two documents side by side as one column of lines: a removed line where the left had something
 * the right does not, an added line the other way round. One column rather than two panes because
 * the question is what changed, not what each revision says in full.
 */
export function DiffView({
    left,
    right,
    empty = 'No differences.',
    testId,
}: {
    left: string;
    right: string;
    /** What to say when the two sides are the same; the caller knows what it is comparing. */
    empty?: string;
    testId?: string;
}) {
    const lines = diffLines(left, right);
    if (!hasChanges(lines)) {
        return (
            <p className="text-body text-text-muted" data-testid={testId}>
                {empty}
            </p>
        );
    }
    return (
        <div className="overflow-x-auto rounded-card border border-border" data-testid={testId}>
            <table className="w-full border-collapse font-mono text-meta">
                <tbody>
                    {lines.map((line, index) => (
                        <Row key={`${line.kind}-${index}`} line={line} />
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const TONE: Record<DiffLine['kind'], string> = {
    same: 'text-text-muted',
    added: 'bg-ok/10 text-ok',
    removed: 'bg-danger/10 text-danger',
};
const MARK: Record<DiffLine['kind'], string> = { same: ' ', added: '+', removed: '-' };

function Row({ line }: { line: DiffLine }) {
    return (
        <tr className={cn(TONE[line.kind])} data-diff={line.kind}>
            <td className="w-10 px-2 text-right tabular-nums opacity-60 select-none">{line.left ?? ''}</td>
            <td className="w-10 px-2 text-right tabular-nums opacity-60 select-none">{line.right ?? ''}</td>
            <td className="w-4 select-none">{MARK[line.kind]}</td>
            <td className="px-2 whitespace-pre">{line.text}</td>
        </tr>
    );
}
