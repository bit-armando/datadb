import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CopyIcon, CheckIcon } from "lucide-react";

function InlineCodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          toast.error("No se pudo copiar");
        }
      }}
      className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      title="Copiar"
    >
      {copied ? <CheckIcon className="size-3 text-gdb-okfg" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

const components: Components = {
  p: ({ children }) => <p className="break-words leading-relaxed">{children}</p>,
  h1: ({ children }) => <h1 className="mt-2 text-[15px] font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 text-[15px] font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-1.5 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-1.5 text-sm font-semibold">{children}</h4>,
  ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border py-0.5 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-1 border-border/60" />,
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-border/60 px-3 py-1.5 text-left font-medium font-jetbrains">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border/40 px-3 py-1.5 font-jetbrains">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
    const text = String(children).replace(/\n$/, "");
    if (!isBlock) {
      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-jetbrains text-[12.5px] text-foreground break-all"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <div className="group relative min-w-0 max-w-full">
        <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 p-3.5 font-jetbrains text-[12.5px] leading-6">
          <code className={className} {...props}>
            {text}
          </code>
        </pre>
        <InlineCodeCopyButton text={text} />
      </div>
    );
  },
};

export function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 max-w-full flex-col gap-2.5 break-words [overflow-wrap:anywhere] text-[13px] leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
