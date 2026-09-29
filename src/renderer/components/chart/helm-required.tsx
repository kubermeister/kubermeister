import { HELM_INSTALL_URL } from '../../../shared/helm-tool';

/**
 * What every way into an install says when no Helm was found, in the same words, so a missing Helm
 * reads as one state wherever it is met rather than as a flow that fails once it tries to render.
 */
export function HelmRequired({ children }: { children?: React.ReactNode }) {
    return (
        <div data-testid="helm-required">
            <p className="text-body font-semibold">Helm is required to install a chart</p>
            <p className="mt-1 text-cell text-text-2">
                Kubermeister renders a chart with the <span className="font-mono">helm</span> installed on this machine,
                using <span className="font-mono">helm template</span> and nothing else, and none was found on the PATH.{' '}
                <a href={HELM_INSTALL_URL} target="_blank" rel="noreferrer" className="text-primary underline">
                    Install Helm 3 or later
                </a>
                , then try again.
            </p>
            {children}
        </div>
    );
}
