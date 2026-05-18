"use client";

import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type AssistantMarkdownProps = {
  content: string;
};

export function AssistantMarkdown({ content }: AssistantMarkdownProps) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => (/^javascript:/i.test(url) ? "" : url)}
        components={{
          a: ({ href, children, ...rest }) => (
            <a
              href={href}
              className="assistant-md-link"
              target="_blank"
              rel="noopener noreferrer"
              {...rest}
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...rest }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="assistant-md-code-inline" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...rest }) => (
            <pre className="assistant-md-pre" {...rest}>
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
