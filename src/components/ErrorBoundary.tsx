import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useState } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const ErrorDetails = ({ error, title }: { error: Error | null; title: string }) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="font-medium text-xs">{title}</span>
      </div>
      {error && (
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Detail chyby
        </button>
      )}
      {showDetails && error && (
        <pre className="mt-1.5 text-[9px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-24 whitespace-pre-wrap">
          {error.message}
        </pre>
      )}
    </div>
  );
};

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ErrorBoundary] ${this.props.fallbackTitle || "Component"}:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mb-4">
          <ErrorDetails
            error={this.state.error}
            title={this.props.fallbackTitle || "Něco se pokazilo"}
          />
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-2 flex items-center gap-1.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Zkusit znovu
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
