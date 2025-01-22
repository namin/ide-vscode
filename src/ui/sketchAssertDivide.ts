import { window, commands, Diagnostic, TextEditor, Position, DiagnosticCollection, languages, OutputChannel, workspace, WorkspaceEdit, Range } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';
import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';

interface AssertDivideState {
  targetAssertion: { line: number, assertion: string };
  depth: number;
  attempt?: { line: number, assertion: string };
  verifiedAssertions: { line: number, assertion: string }[];
  uri: string;
}

export default class SketchAssertDivide {
  private static readonly assertDivideStates = new Map<string, AssertDivideState>();
  private static diagnosticsListener: DiagnosticCollection;
  private static outputChannel: OutputChannel;

  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): SketchAssertDivide {
    this.diagnosticsListener = languages.createDiagnosticCollection('dafny');
    this.outputChannel = window.createOutputChannel('Dafny Assert-Divide');

    // Listen for diagnostic updates
    installer.context.subscriptions.push(
      languages.onDidChangeDiagnostics(() => {
        this.outputChannel.appendLine('Diagnostics changed, handling...');
        this.handleDiagnosticsChange(client);
      })
    );

    return new SketchAssertDivide();
  }

  private static getAssertDivideStates(uri: string): AssertDivideState | undefined {
    return this.assertDivideStates.get("global");
  }
  private static deleteAssertDivideStates(uri: string) {
    this.assertDivideStates.delete("global");
  }
  private static setAssertDivideStates(uri: string, state: AssertDivideState) {
    this.assertDivideStates.set("global", state);
  }
  

  private static async tryAssertStep(client: DafnyLanguageClient, editor: TextEditor, documentUri: string) {
    const state = this.getAssertDivideStates(documentUri);
    this.outputChannel.appendLine("URI: " + documentUri);
    if(!state) {
       this.outputChannel.appendLine("tryAssertStep: No state...");
      return;
    }

    if(state.depth > 5) {
      this.outputChannel.appendLine('Maximum depth reached');
      window.showInformationMessage('Assert-divide: Max depth reached without success');
      this.deleteAssertDivideStates(documentUri);
      return;
    }
 
    state.depth++;
    this.outputChannel.appendLine(`\nTrying assert step at depth ${state.depth}`);

    // Generate and try intermediate assertion
    const intermediate = await this.generateIntermediateAssertion(client, editor, state);
    if(!intermediate) {
      this.outputChannel.appendLine('Failed to generate intermediate assertion');
      this.deleteAssertDivideStates(documentUri);
      return;
    }

    // Insert it and trigger verification
    await this.insertAssertion(editor, intermediate, state.targetAssertion.line);
    // Update line numbers since we inserted above
    state.targetAssertion.line++;
    intermediate.line = state.targetAssertion.line - 1;
    state.attempt = intermediate;

    await commands.executeCommand(DafnyCommands.Build);
    // Further progress handled by diagnostic change
  }

  private static async generateIntermediateAssertion(
    client: DafnyLanguageClient,
    editor: TextEditor,
    state: AssertDivideState
  ): Promise<{ line: number, assertion: string } | null> {
    const context = await this.getAssertionContext(editor, state.targetAssertion.line);

    const prompt = `Given the following Dafny verification context, suggest a single-line logical step that would help prove the target assertion. Your response must be exactly one assertion, no comments, no additional explanation. The assertion must be simpler than the target and follow directly from the context.

Context:
${context}

Target assertion: ${state.targetAssertion.assertion}

Provide just the assertion without 'assert' keyword or semicolon.`;

    try {
      const document = workspace.textDocuments.find(doc => doc.uri.fsPath === state.uri);
      let content;
      if (document) {
        await document.save();
        this.outputChannel.appendLine('Document saved before next step');
        content = document.getText();
      } else {
        content = editor.document.getText();
      }
      this.outputChannel.appendLine("Content for AI:" + content);

      const result = await client.generateSketch({
        prompt,
        content: editor.document.getText(),
        sketchType: 'ai_whole',
        position: new Position(state.targetAssertion.line, 0),
        textDocument: { uri: state.uri }
      });

      if(result?.sketch) {
        // Clean and validate the response
        let assertion = result.sketch.trim();
        // Remove any 'assert' or semicolon if AI included them
        assertion = assertion.replace(/^assert\s+/, '').replace(/;$/, '');

        // Check for multiple lines or assertions
        if(assertion.includes('\n')) {
          this.outputChannel.appendLine('AI returned multiple lines/assertions, skipping');
          this.outputChannel.appendLine(assertion);
          return null;
        }

        return {
          line: state.targetAssertion.line,
          assertion: assertion
        };
      }
    } catch(e) {
      this.outputChannel.appendLine('Error generating assertion: ' + e);
    }
    return null;
  }

  private static async insertAssertion(
    editor: TextEditor,
    assertion: { line: number, assertion: string },
    line: number
  ): Promise<void> {
    const workspaceEdit = new WorkspaceEdit();
    workspaceEdit.insert(
      editor.document.uri,
      new Position(line, 0),
      `    assert ${assertion.assertion}; // Intermediate step\n`
    );
    await workspace.applyEdit(workspaceEdit);
  }

  private static async commentOutLine(
    editor: TextEditor,
    line: number
  ): Promise<void> {
    const edit = new WorkspaceEdit();
    const document = editor.document;
    const lineText = document.lineAt(line).text;
    const uri = document.uri;
    
    edit.replace(
      uri,
      new Range(new Position(line, 0), new Position(line, lineText.length)),
      `// ${lineText}`  // Add comment prefix
    );
  
    await workspace.applyEdit(edit);
  }

  private static async handleDiagnosticsChange(client: DafnyLanguageClient) {
    const editor = window.activeTextEditor;
    if(!editor) {
      this.outputChannel.appendLine('No active editor, skipping diagnostic handling');
      return;
    }

    const documentUri = editor.document.uri.toString();
    this.outputChannel.appendLine("URI: " + documentUri);
    const state = this.getAssertDivideStates(documentUri);
    if(!state) {
      this.outputChannel.appendLine('handleDiagnosticChange: No state...');
      // Only log if we have verification errors
      const currentDiagnostics = this.diagnosticsListener.get(editor.document.uri) || [];
      const verificationDiagnostics = currentDiagnostics.filter(d =>
        d.message.includes('could not be proved')
        || d.message.includes('assertion might not hold'));
      if(verificationDiagnostics.length > 0) {
        this.outputChannel.appendLine('Got verification errors but no assert-divide state active');
      }
      return;
    }

    // Get verification status
    const diagnostics: Diagnostic[] = [];
    for (const [uri, uriDiagnostics] of languages.getDiagnostics()) {
      this.outputChannel.appendLine(`errors for ${uri}`)
      uriDiagnostics.forEach(error => {
        this.outputChannel.appendLine(`l. ${error.range.start.line}: ${error.message}`);
        diagnostics.push(error);
      });
    }

    const verificationErrors = new Set(
      diagnostics
        //.filter(d => d.message.includes('could not be proved') || d.message.includes('assertion might not hold'))
        .map(d => d.range.start.line)
    );

    this.outputChannel.appendLine(`\nDiagnostic check:\n  Target assertion at line ${state.targetAssertion.line}\n  Current attempt at line ${state.attempt?.line}\n  Verification errors at lines: ${[...verificationErrors].join(', ')}`);

    // Check if target assertion verifies
    let targetOK = false;
    if(!verificationErrors.has(state.targetAssertion.line)) {
      this.outputChannel.appendLine('Target assertion verified!');
      targetOK = true;
    } 
    // Check if current attempt verifies
    if(state.attempt) {
      let newOK = false;
      if(!verificationErrors.has(state.attempt.line)) {
        this.outputChannel.appendLine('Intermediate assertion verified');
        newOK = true;
      } else {
        this.outputChannel.appendLine('Intermediate assertion failed');
      }
      if(targetOK) {
        if(!newOK) {
          // moving up
          state.verifiedAssertions.push(state.targetAssertion);
          state.targetAssertion = state.attempt;
          state.attempt = undefined;
          await this.tryAssertStep(client, editor, documentUri);
        } else if(newOK) {
          this.outputChannel.appendLine('Bingo!');
          window.showInformationMessage('Assert-divide: Successfully verified target assertion!');
          this.deleteAssertDivideStates(documentUri);
        } else {
          // Need to try a different intermediate assertion
          this.outputChannel.appendLine('Intermediate assertion failed to verify or help, trying again');
          this.commentOutLine(editor, state.attempt.line);
          await this.tryAssertStep(client, editor, documentUri);
        }
      }
    } else if(targetOK) {
      this.outputChannel.appendLine('No intermediate assertion and target not verifying.');
      this.deleteAssertDivideStates(documentUri);
    } else {
      this.outputChannel.appendLine('No intermediate assertion and target not verifying.');
      this.deleteAssertDivideStates(documentUri);
    }
  }

  public static async handle(editor: TextEditor, document: any, client: DafnyLanguageClient): Promise<any> {
    this.outputChannel.appendLine('\n=== Starting new assert-divide operation ===');
    //this.outputChannel.show(); // Force show the output channel
    window.showInformationMessage('Starting assert-divide');
    
    const assertInfo = await this.extractAssertInfo(editor);
    if(!assertInfo) {
      this.outputChannel.appendLine('No valid assertion found at cursor');
      return null;
    }
    this.outputChannel.appendLine(`Found assertion: ${assertInfo.assertion} at line ${assertInfo.line}`);

    // Initialize state with our target assertion
    const uri = document.uri.fsPath.toString();
    this.setAssertDivideStates(uri, {
      targetAssertion: assertInfo,
      depth: 0,
      verifiedAssertions: [],
      uri: uri
    });

    // Start the recursive process
    await this.tryAssertStep(client, editor, uri);
    return null;
  }

  private static async extractAssertInfo(editor: TextEditor): Promise<{ line: number, assertion: string } | null> {
    const selection = editor.selection;
    const currentLine = editor.document.lineAt(selection.start.line);
    const text = currentLine.text;
    this.outputChannel.appendLine(`Examining line: ${text}`);

    if(!text.trim().startsWith("assert")) {
      this.outputChannel.appendLine("Line does not start with 'assert'");
      window.showInformationMessage("Please place cursor on an assert statement");
      return null;
    }

    const assertMatch = text.match(/assert\s+(.*?);/);
    if(!assertMatch) {
      this.outputChannel.appendLine("Could not parse assertion statement");
      return null;
    }

    this.outputChannel.appendLine(`Successfully extracted assertion: ${assertMatch[1]}`);
    return {
      line: selection.start.line,
      assertion: assertMatch[1].trim()
    };
  }

  private static async getAssertionContext(editor: TextEditor, line: number): Promise<string> {
    // Get a few lines before and after for context
    const startLine = Math.max(0, line - 5);
    const endLine = Math.min(editor.document.lineCount, line + 5);
    let context = '';

    for(let i = startLine; i < endLine; i++) {
      const lineText = editor.document.lineAt(i).text;
      if(i === line) {
        context += '>>> ' + lineText + ' <<<\n';
      } else {
        context += lineText + '\n';
      }
    }

    return context;
  }
}