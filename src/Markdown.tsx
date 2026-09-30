// Assistant markdown — distilled from the DSH client's MarkdownText/render
// pipeline (ui-primitives/src/markdown). DSH parses with remark and switches
// over mdast nodes; this keeps the same node→element mapping and emits the
// same class names that the vendored DSH sheets style (markdown-text.module.css
// + code-block.module.css), so the typography is the real harness baseline
// rather than an approximation.
import { Fragment, createElement, type ReactNode } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, PhrasingContent, List, Table, Code } from "mdast";

const processor = unified().use(remarkParse).use(remarkGfm);

interface Props {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: Props) {
  const tree = processor.parse(children) as Root;
  return (
    <div className={["markdown", className].filter(Boolean).join(" ")}>
      {renderBlocks(tree.children)}
    </div>
  );
}

function renderBlocks(nodes: RootContent[]): ReactNode[] {
  return nodes.map((node, i) => <Fragment key={i}>{renderBlock(node)}</Fragment>);
}

function renderBlock(node: RootContent): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p>{renderInline(node.children)}</p>;
    case "heading": {
      const tag = `h${node.depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return createElement(tag, null, renderInline(node.children));
    }
    case "code":
      return <CodeBlock node={node} />;
    case "blockquote":
      return <blockquote>{renderBlocks(node.children as RootContent[])}</blockquote>;
    case "list":
      return renderList(node);
    case "listItem":
      // Only reachable for malformed trees; lists render their items directly.
      return <li>{renderBlocks(node.children as RootContent[])}</li>;
    case "thematicBreak":
      return <hr />;
    case "table":
      return renderTable(node);
    case "html":
      // Markdown HTML is rendered as text, matching the harness sandbox policy
      // (no raw HTML injection into the transcript).
      return <p>{node.value}</p>;
    default:
      return null;
  }
}

function renderList(node: List): ReactNode {
  const items = node.children.map((item, i) => (
    <li key={i}>
      {item.checked !== null && item.checked !== undefined && (
        <input type="checkbox" checked={item.checked} readOnly className="task" />
      )}
      {renderBlocks(item.children as RootContent[])}
    </li>
  ));
  // A "loose"/spread list becomes <div> children in mdast; handle both.
  return node.ordered ? (
    <ol start={node.start ?? 1}>{items}</ol>
  ) : (
    <ul>{items}</ul>
  );
}

function renderTable(node: Table): ReactNode {
  const [head, ...body] = node.children;
  const aligns = Array.isArray(node.align) ? node.align : [];
  const alignOf = (i: number): React.CSSProperties | undefined => {
    const a = aligns[i];
    return a ? { textAlign: a as React.CSSProperties["textAlign"] } : undefined;
  };
  return (
    <div className="tableScroll">
      <table>
        <thead>
          <tr>
            {head?.children.map((cell, i) => (
              <th key={i} style={alignOf(i)}>
                {renderInline(cell.children)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>
              {row.children.map((cell, j) => (
                <td key={j} style={alignOf(j)}>
                  {renderInline(cell.children)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline nodes → elements, mapping mdast phrasing to the harness DOM. */
function renderInline(nodes: PhrasingContent[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.value}</Fragment>;
      case "strong":
        return <strong key={i}>{renderInline(node.children)}</strong>;
      case "emphasis":
        return <em key={i}>{renderInline(node.children)}</em>;
      case "delete":
        return <del key={i}>{renderInline(node.children)}</del>;
      case "inlineCode":
        return <code key={i}>{node.value}</code>;
      case "link":
        return (
          <a key={i} href={node.url} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
      case "break":
        return <br key={i} />;
      case "image":
        return <img key={i} className="image" src={node.url} alt={node.alt ?? ""} />;
      case "footnoteReference":
        return (
          <sup key={i}>
            <a href={`#${node.identifier}`}>{node.label ?? node.identifier}</a>
          </sup>
        );
      default:
        return null;
    }
  });
}

/**
 * A fenced code block in the harness shape: banner with the infostring and a
 * copy action, then the content. Highlighting (shiki) is layered later; the
 * block chrome and tokens come from the vendored code-block sheet.
 */
function CodeBlock({ node }: { node: Code }) {
  return (
    <div className="block md-code-block" data-code-block>
      <div className="bannerWrap">
        <div className="banner" data-code-block-banner>
          <div className="infostring">{node.lang ?? ""}</div>
          <div className="action">
            <button
              type="button"
              className="copyButton"
              onClick={() => {
                void navigator.clipboard?.writeText(node.value);
              }}
            >
              Copy
            </button>
          </div>
        </div>
      </div>
      <div className="content" data-code-block-content>
        <pre className="plain">
          <code className={node.lang ?? undefined}>{node.value}</code>
        </pre>
      </div>
    </div>
  );
}
