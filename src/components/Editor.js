import React from 'react';
import PropTypes from 'prop-types';
import screenfull from 'screenfull';
import autoBind from 'react-autobind';
import Typo from 'typo-js';
import CommandPalette from './CommandPalette';
import Outline from './Outline';
import StatusBar from './StatusBar';
import { createNinja, ninjasToHtml } from './editor/lineNinja';
import { autosaveStore, autosaveRetrieve } from './editor/autosave';
import getCommands from './editor/commands';
import { nthIndexOf, findNextSibling, findRelativeOffset, moveSubstring, generateOutline, findWordBounds } from '../helpers/helpers';
import { addSpellcheck } from '../spellcheck/spellcheck';

const STOPPED_TYPING_TIMEOUT = 300;
const STOPPED_CURSOR_ACTIVITY_TIMEOUT = 300;

class Editor extends React.Component {
  static propTypes = {
    content: PropTypes.string,
    language: PropTypes.shape({
      name: PropTypes.string.isRequired,
      getToHtml: PropTypes.func.isRequired,
      lineSafeInsert: PropTypes.func,
      headerRegex: PropTypes.regex,
      renderJsxStyle: PropTypes.func,
      previewClassName: PropTypes.string,
    }),
  }
  static defaultProps = {
    content: '',
    language: {
      name: 'markdown',
      lineSafeInsert: line => line,
      renderJsxStyle: () => {},
      previewClassName: '',
    },
  }
  constructor(props) {
    super(props);
    const defaultCmOptions = {
      scrollbarStyle: null,
      lineWrapping: true,
      lineNumbers: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      foldGutter: true,
      theme: 'material',
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      extraKeys: {
        'Ctrl-P': 'jumpToLine',
        'Ctrl-Space': 'autocomplete',
        'Ctrl-Q': (cm) => { cm.foldCode(cm.getCursor()); },
      },
      keyMap: 'sublime',
    };

    autoBind(this);

    const html = this.generateHtml(props.content);
    const raw = props.content;
    this.state = {
      raw,
      html,
      outline: this.generateOutline(this.props.content),
      proportionalSizes: true,
      stoppedTypingTimer: null,
      stoppedCursorActivityTimer: null,
      columns: {
        editor: true,
        preview: true,
        outline: true,
      },
      autosaved: null,
      lastScrolled: null,
      loc: raw.split('\n').length,
      options: {
        mode: 'spellcheck',
        backdrop: props.language.name,
        ...defaultCmOptions,
      },
      cursorLine: 1,
      cursorCol: 1,
    };
    this.typo = new Typo('en_US', false, false, {
      platform: 'any',
      dictionaryPath: 'dictionaries',
    });
  }
  componentDidMount() {
    if (typeof CodeMirror !== 'undefined' && CodeMirror) {
      /* global CodeMirror */
      CodeMirror.registerHelper('hint', 'anyword', (cm) => {
        const { line, ch } = cm.getCursor();
        const str = cm.getLine(line);
        const [start, end] = findWordBounds(str, ch);
        return {
          list: this.typo.suggest(str.slice(start, end)),
          from: { line, ch: start },
          to: { line, ch: end },
        };
      });
      addSpellcheck(CodeMirror, this.typo);
      this.cm = CodeMirror.fromTextArea(this.textarea, {
        ...this.state.options,
      });
      this.cm.on('change', cm => this.handleChange(cm.getValue()));
      this.cm.on('cursorActivity', () => this.handleCursorActivity());
    } else if (process.env.NODE_ENV !== 'test') {
      console.error('CodeMirror is not defined. Forgot to include script?');
    }
    this.autosaveRetrieve();
  }
  getValue() {
    return this.state.raw;
  }
  getVisibleLines(columnNode, nodeScrollTop, lineSelector, numberSelector = null) {
    const editorScroll = nodeScrollTop;
    let firstVisibleLine = null;
    const visibleLines = [...columnNode.querySelectorAll(lineSelector)]
      .map((_, i) => [_, i])
      .filter(([lineNode, i]) => {
        const lineOffsetTop = findRelativeOffset(lineNode, columnNode);
        if (lineOffsetTop >= editorScroll) {
          if (firstVisibleLine === null) {
            firstVisibleLine = i;
            return true;
          }
          return lineOffsetTop <= editorScroll + this.state.height;
        }
        return false;
      })
      // if numberSelector null, use index
      .map(([lineNode, i]) => (numberSelector ? numberSelector(lineNode) : i));
    return visibleLines;
  }
  handleOutlineClick(heading) {
    const inCode = heading.source;
    const value = this.state.raw;
    const pos = nthIndexOf(value, inCode, heading.dupIndex);
    const line = value.substr(0, pos).split('\n').length - 1;
    this.cm.setCursor(line);
    this.cm.focus();
  }
  scrollPreviewToLine(ln) {
    let lineNode = this.previewColumn.querySelector(`strong[data-line="${ln}"]`);
    for (let i = ln; i > 0 && !lineNode; i -= 1) {
      lineNode = this.previewColumn.querySelector(`strong[data-line="${i}"]`);
    }
    this.previewColumn.scrollTop = findRelativeOffset(lineNode, this.previewColumn);
  }
  scrollEditorToLine(ln) {
    const to = this.cm.charCoords({ line: ln - 1, ch: 0 }, 'local').top;
    this.cm.scrollTo(null, to);
  }
  handlePreviewScroll() {
    if (this.state.lastScrolled === 'editor') {
      this.setState({
        ...this.state,
        lastScrolled: null,
      });
      return;
    }
    const [firstVisibleLine] = this.getVisibleLines(this.previewColumn, this.previewColumn.scrollTop, 'strong[data-line]', node => Number(node.dataset.line));
    this.scrollEditorToLine(firstVisibleLine);
    this.setState({
      ...this.state,
      lastScrolled: 'preview',
    });
  }
  handleEditorScroll(e) {
    if (e.target.scrollTop === 0) {
      // triggered by typing
      return;
    }
    if (this.state.lastScrolled === 'preview') {
      this.setState({
        ...this.state,
        lastScrolled: null,
      });
      return;
    }
    const offset = this.cm.getViewport().from;
    const [firstVisibleLineRelative] = this.getVisibleLines(this.cm.getScrollerElement(), this.cm.getScrollerElement().scrollTop + this.editorColumn.scrollTop, '.CodeMirror-line');
    const firstVisibleLine = firstVisibleLineRelative + offset;
    this.scrollPreviewToLine(firstVisibleLine);
    this.setState({
      ...this.state,
      lastScrolled: 'editor',
    });
  }
  updateStateValue(value) {
    const html = this.generateHtml(value);
    const raw = value;
    this.setState({
      raw,
      html,
      loc: raw.split('\n').length,
      outline: this.generateOutline(raw),
    });
  }
  handleChange(value) {
    if (this.state.stoppedTypingTimer) {
      clearTimeout(this.state.stoppedTypingTimer);
    }
    this.setState({
      ...this.state,
      raw: value,
      stoppedTypingTimer: setTimeout(() => this.handleStoppedTyping(value), STOPPED_TYPING_TIMEOUT),
    });
  }
  handleStoppedTyping(value) {
    this.autosaveStore(value);
    this.updateStateValue(value);
  }
  autosaveStore(value) {
    const { date } = autosaveStore(value);
    this.setState({
      ...this.state,
      autosaved: date,
    });
  }
  autosaveRetrieve() {
    const retrieved = autosaveRetrieve();
    if (retrieved) {
      const { value, date } = retrieved;
      if (this.cm) {
        this.cm.setValue(value);
      }
      this.updateStateValue(value);
      this.setState({
        ...this.state,
        autosaved: date,
      });
    }
  }
  handleStoppedCursorActivity() {
    this.updateCursor();
  }
  updateCursor() {
    if (this.cm) {
      const { line, ch } = this.cm.getCursor();
      this.setState({
        ...this.state,
        cursorLine: line + 1,
        cursorCol: ch + 1,
      });
    }
  }
  generateHtml(raw) {
    const rawWithNinjas = raw
      .split('\n')
      .map((line, i) => this.props.language.lineSafeInsert(line, createNinja(i)))
      .join('\n');
    return ninjasToHtml(this.props.language.getToHtml()(rawWithNinjas));
  }
  handleCommand(command) {
    getCommands(this)[command].execute();
  }
  handleCursorActivity() {
    if (this.state.stoppedCursorActivityTimer) {
      clearTimeout(this.state.stoppedCursorActivityTimer);
    }
    this.setState({
      ...this.state,
      stoppedCursorActivityTimer: setTimeout(
        this.handleStoppedCursorActivity,
        STOPPED_CURSOR_ACTIVITY_TIMEOUT,
      ),
    });
  }
  toggleFullscreen() {
    screenfull.on('change', () => {
      if (!screenfull.isFullscreen && this.state.fullscreen) {
        this.setState({
          ...this.state,
          fullscreen: false,
        });
      }
    });
    if (this.state.fullscreen) {
      screenfull.exit();
    } else {
      screenfull.request(this.editor);
    }
    this.setState({
      ...this.state,
      fullscreen: !this.state.fullscreen,
    });
  }
  handleOutlineOrderChange(header, { oldIndex, newIndex }) {
    // Do nothing if no distance
    if (oldIndex === newIndex) {
      return;
    }
    // Container in which headers are swapped
    const container = header ? header.children : this.state.outline;
    // Header section to move
    const movingItem = container[oldIndex];

    // [cutStart, cutEnd, pasteStart, (pasteEnd)]
    const indicies = [
      movingItem,
      findNextSibling(movingItem),
      // Header section to paste before
      newIndex > oldIndex ? findNextSibling(container[newIndex]) : container[newIndex],
    ].map(item => (item ?
      nthIndexOf(this.state.raw, item.source, item.dupIndex) : this.state.raw.length
    ));

    // Move the section
    const newValue = moveSubstring(this.state.raw, ...indicies);

    this.updateStateValue(newValue);
    if (this.cm) {
      this.cm.setValue(newValue);
    }
  }
  generateOutline(raw) {
    return generateOutline(
      raw,
      this.props.language.getToHtml(),
      this.props.language.headerRegex,
    );
  }
  renderProportianalStyles() {
    if (this.state.proportionalSizes) {
      return (
        <style jsx global>{`
                .cm-header-1 { font-size: 2em; }
                .cm-header-2 { font-size: 1.5em; }
                .cm-header-3 { font-size: 1.32em; }
                .cm-header-4 { font-size: 1.15em; }
                .cm-header-5 { font-size: 1.07em; }
                .cm-header-6 { font-size: 1.03em; }
            `}
        </style>
      );
    }
    return null;
  }
  renderColumn(name) {
    switch (name) {
      case 'outline':
        return (
          <div className="columnWrapper">
            <div className="column outline">
              <Outline
                outline={this.state.outline}
                onItemClick={this.handleOutlineClick}
                onOrderChange={this.handleOutlineOrderChange}
              />
            </div>
          </div>
        );
      case 'editor':
        return (
          <div className="columnWrapper">
            <div className="column" onScroll={this.handleEditorScroll} ref={(el) => { this.editorColumn = el; }}>
              <textarea
                ref={(el) => { this.textarea = el; }}
                onChange={e => this.handleChange(e.target.value)}
                defaultValue={this.state.raw}
              />
            </div>
          </div>
        );
      case 'preview':
        return (
          <div className="columnWrapper">
            <div className="column" onScroll={this.handlePreviewScroll} ref={(el) => { this.previewColumn = el; }}>
              <div
                className={`preview ${this.props.language.previewClassName}`}
                role="presentation"
                spellCheck="false"
                contentEditable
                onKeyPress={(e) => { e.preventDefault(); }}
                // eslint-disable-next-line react/no-danger
                dangerouslySetInnerHTML={{ __html: this.state.html }}
              />
            </div>
          </div>
        );
      default:
        throw new Error(`Prompted to render unknown column ${name}`);
    }
  }
  render() {
    const commandPaletteOptions = Object.entries(getCommands(this))
      .reduce((acc, [k, v]) => { acc[k] = v.text; return acc; }, {});
    let markupEditorStyles = {
      display: 'flex',
      width: 'inherit',
      height: 'inherit',
    };
    if (this.state.fullscreen) {
      markupEditorStyles = {
        ...markupEditorStyles,
        width: '100vw',
        height: '100vh',
      };
    }
    return (
      <div className="markup-editor-wrapper">
        <div
          className="markup-editor"
          role="presentation"
          onKeyDown={(e) => {
                        if (e.shiftKey && e.ctrlKey) {
                          switch (e.key) {
                              case 'p':
                              case 'P':
                                  e.preventDefault();
                                  this.commandPalette.focus();
                                  break;
                              default:
                          }
                        }
                    }}
          style={markupEditorStyles}
          ref={(el) => { this.editor = el; }}
        >
          <CommandPalette
            ref={(el) => { this.commandPalette = el; }}
            options={commandPaletteOptions}
            onSelected={this.handleCommand}
            onExit={() => { this.cm.focus(); }}
          />
          <div className="workspace">
            {
              [
                'outline',
                'editor',
                'preview',
              ].map((name) => {
                if (this.state.columns[name]) {
                  return this.renderColumn(name);
                }
                return null;
              })
            }
          </div>
          <StatusBar
            loc={this.state.loc}
            col={this.state.cursorCol}
            line={this.state.cursorLine}
            autosaved={this.state.autosaved}
            onCommandPalette={() => this.commandPalette.focus()}
          />
        </div>
        <style jsx global>{`
                  .markup-editor-wrapper {
                    display: flex;
                    height: inherit;
                    width: inherit;
                    align-items: flex-start;
                  }
                  .CodeMirror {
                      font-family: 'Roboto Mono', monospace;
                      height: 2000px;
                      overflow: visible;
                  }
                  .markup-editor {
                      position: relative;
                      border: 1px solid #222;
                      border-bottom: 0;
                      width: auto;
                      height: auto;
                      display: flex;
                      align-items: flex-start;
                      padding-bottom: 20px;
                  }
                  .preview {
                      font-family: 'Roboto', sans-serif;
                      padding: 10px 60px;
                  }
                  .preview:focus {
                      outline: 0px solid transparent;
                  }
                  .preview > div {
                      padding: 0 50px 0 20px;
                  }
                  .preview .cursor {
                      visibility: hidden;
                      display: inline-block;
                      width: 0;
                      height: 0;
                  }
                  .preview *[data-line] {
                      display: inline-flex;
                      visibility: hidden;
                      width: 0;
                      height: 0;
                  }
                  .markup-editor .workspace {
                      align-items: stretch;
                      display: flex;
                      height: inherit;
                      width: inherit;
                      align-items: flex-start;
                  }
                  .markup-editor .workspace > .columnWrapper {
                      flex: 6;
                      overflow: hidden;
                      height: inherit;
                  }
                  .markup-editor .workspace > .columnWrapper > .column {
                      overflow-y: scroll;
                      overflow-x: hidden;
                      height: inherit;
                      position: relative; // important for scroll synchro!
                      margin-right: -16px;
                  }
                  .markup-editor .workspace > .column.outline {
                    flex: 2;
                  }
                  .markup-editor .workspace {
                    overflow: hidden;

                  }
                  .cm-spell-error {
                    text-decoration: underline #FF6358 wavy;
                  }
                `}
        </style>
        {this.props.language.renderJsxStyle && this.props.language.renderJsxStyle()}
        {this.renderProportianalStyles()}
      </div>
    );
  }
}

export default Editor;
