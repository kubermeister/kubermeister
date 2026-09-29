import { Button } from '@/components/ui/button';
import { ReadErrorHints } from '@/components/templates/read-error-hints';
import { describeError, readErrorSentence, type ReadSubject } from '@/lib/k8s-error';

interface ReadFailureProps {
    error: unknown;
    /** What was being read, in the words a list or detail screen would use for it. */
    subject: ReadSubject;
    onRetry?: () => void;
    testId?: string;
}

/**
 * A failed read inside a tab, worded as the detail and list screens word theirs: the classified
 * title, the shared sentence, the detail when it adds something, and the hints a timeout earns. A
 * tab that shows nothing, or "nothing here", for a failed read tells the reader something untrue.
 */
export function ReadFailure({ error, subject, onRetry, testId = 'read-failure' }: ReadFailureProps) {
    const failure = describeError(error);
    const sentence = readErrorSentence(failure.kind, subject);
    const noun = 'plural' in subject ? subject.plural : `this ${subject.one}`;
    return (
        <div className="flex flex-col items-start gap-1 text-body text-text-muted" role="alert" data-testid={testId}>
            <span className="font-medium text-foreground">{failure.title}</span>
            <span>{sentence}</span>
            {failure.detail !== failure.title && failure.detail !== sentence && (
                <span className="max-w-xl text-meta text-text-dim">{failure.detail}</span>
            )}
            <ReadErrorHints kind={failure.kind} noun={noun} />
            {onRetry && (
                <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
                    Retry
                </Button>
            )}
        </div>
    );
}
