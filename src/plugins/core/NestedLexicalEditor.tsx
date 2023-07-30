/* eslint-disable @typescript-eslint/no-unsafe-argument */
import {
  $addUpdateTag,
  $getNodeByKey,
  $getRoot,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  DecoratorNode,
  EditorConfig,
  KEY_BACKSPACE_COMMAND,
  LexicalEditor,
  createEditor
} from 'lexical'
import * as Mdast from 'mdast'
import { Node } from 'unist'
import React from 'react'
import { corePluginHooks } from './realmPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary'
import { LexicalNestedComposer } from '@lexical/react/LexicalNestedComposer'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { lexicalTheme } from '../../styles/lexicalTheme'
import { exportLexicalTreeToMdast } from '../../exportMarkdownFromLexical'
import { importMdastTreeToLexical } from '../../importMarkdownToLexical'
import styles from '../../styles/ui.module.css'
import { SharedHistoryPlugin } from './SharedHistoryPlugin'
import { mergeRegister } from '@lexical/utils'

interface NestedEditorsContextValue<T extends Node> {
  parentEditor: LexicalEditor
  config: EditorConfig
  mdastNode: T
  lexicalNode: DecoratorNode<any> & {
    setMdastNode: (mdastNode: any) => void
  }
}

export const NestedEditorsContext = React.createContext<NestedEditorsContextValue<Node> | undefined>(undefined)

export const useNestedEditorContext = <T extends Mdast.Content>() => {
  const context = React.useContext(NestedEditorsContext) as NestedEditorsContextValue<T> | undefined
  if (!context) {
    throw new Error('useNestedEditor must be used within a NestedEditorsProvider')
  }
  return context
}

/**
 * A hook that returns a function that can be used to update the mdast node. Use this in your custom editor components.
 */
export function useMdastNodeUpdater<T extends Mdast.Content>() {
  const { parentEditor, lexicalNode } = useNestedEditorContext<T>()

  return function updateMdastNode(node: Partial<T>) {
    parentEditor.update(() => {
      $addUpdateTag('history-push')
      const currentNode = $getNodeByKey(lexicalNode.getKey())
      if (currentNode) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        currentNode.setMdastNode(node)
      }
    })
  }
}

/**
 * A hook that returns a function that removes the lexical node from the editor.
 */
export function useLexicalNodeRemove() {
  const { parentEditor, lexicalNode } = useNestedEditorContext()

  return () => {
    parentEditor.update(() => {
      const node = $getNodeByKey(lexicalNode.getKey())
      node!.selectNext()
      node!.remove()
    })
  }
}

/**
 * The properties of the {@link NestedEditor} React Component.
 * @typeParam T - The type of the mdast node of the editor.
 */
export interface NestedEditorProps<T extends Mdast.Content> {
  /**
   * A function that returns the phrasing content of the mdast node. In most cases, this will be the `children` property of the mdast node, but you can also have multiple nested nodes with their own children.
   */
  getContent: (mdastNode: T) => Mdast.Content[]

  /**
   * A function that should return the updated mdast node based on the original mdast node and the new content (serialized as mdast tree) produced by the editor.
   */
  getUpdatedMdastNode: (mdastNode: T, children: Mdast.Content[]) => T

  /**
   * Props passed to the {@link https://github.com/facebook/lexical/blob/main/packages/lexical-react/src/LexicalContentEditable.tsx | ContentEditable} component.
   */
  contentEditableProps?: React.ComponentProps<typeof ContentEditable>

  /**
   * Whether or not the editor edits blocks (multiple paragraphs)
   */
  block?: boolean
}

/**
 * A nested editor React component that allows editing of the contents of complex markdown nodes that have nested markdown content (for example, custom directives or JSX elements). See the {@link NestedEditorProps} for more details on the compoment props.
 *
 * @example
 * You can use a type param to specify the type of the mdast node
 *
 * ```tsx
 *
 * interface CalloutDirectiveNode extends LeafDirective {
 *   name: 'callout'
 *   children: Mdast.PhrasingContent[]
 * }
 *
 * return <NestedEditor<CalloutDirectiveNode> getContent={node => node.children} getUpdatedMdastNode={(node, children) => ({ ...node, children })} />
 * ```
 */
export const NestedLexicalEditor = function <T extends Mdast.Content>(props: NestedEditorProps<T>) {
  const { getContent, getUpdatedMdastNode, contentEditableProps, block = false } = props
  const { mdastNode } = useNestedEditorContext<T>()
  const updateMdastNode = useMdastNodeUpdater<T>()
  const removeNode = useLexicalNodeRemove()
  const content = getContent(mdastNode)

  const [importVisitors, exportVisitors, usedLexicalNodes, jsxComponentDescriptors, jsxIsAvailable] = corePluginHooks.useEmitterValues(
    'importVisitors',
    'exportVisitors',
    'usedLexicalNodes',
    'jsxComponentDescriptors',
    'jsxIsAvailable'
  )

  const [editor] = React.useState(() => {
    const editor = createEditor({
      nodes: usedLexicalNodes,
      theme: lexicalTheme
    })
    return editor
  })

  React.useEffect(() => {
    editor.update(() => {
      $getRoot().clear()
      let theContent: Mdast.PhrasingContent[] | Mdast.Content[] = content
      if (block) {
        if (theContent.length === 0) {
          theContent = [{ type: 'paragraph', children: [] }]
        }
      } else {
        theContent = [{ type: 'paragraph', children: content as Mdast.PhrasingContent[] }]
      }

      importMdastTreeToLexical({
        root: $getRoot(),
        mdastRoot: {
          type: 'root',
          children: theContent
        },
        visitors: importVisitors
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, block, importVisitors])

  React.useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        BLUR_COMMAND,
        () => {
          editor.getEditorState().read(() => {
            const mdast = exportLexicalTreeToMdast({
              root: $getRoot(),
              visitors: exportVisitors,
              jsxComponentDescriptors,
              jsxIsAvailable
            })
            const content: Mdast.Content[] = block ? mdast.children : (mdast.children[0] as Mdast.Paragraph)!.children
            updateMdastNode(getUpdatedMdastNode(structuredClone(mdastNode) as any, content as any))
          })
          return true
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (_, editor) => {
          const editorElement = editor.getRootElement()
          // the innerText here is actually the text before backspace takes effect.
          if (editorElement?.innerText === '\n') {
            removeNode()
            return true
          }
          return false
        },
        COMMAND_PRIORITY_CRITICAL
      )
    )
  }, [block, editor, exportVisitors, getUpdatedMdastNode, jsxComponentDescriptors, jsxIsAvailable, mdastNode, removeNode, updateMdastNode])

  return (
    <LexicalNestedComposer initialEditor={editor}>
      <RichTextPlugin
        contentEditable={<ContentEditable {...contentEditableProps} className={styles.nestedEditor} />}
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <SharedHistoryPlugin />
    </LexicalNestedComposer>
  )
}