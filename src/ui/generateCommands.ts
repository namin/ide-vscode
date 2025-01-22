import { window, commands, Diagnostic, TextEditor, Position, DiagnosticCollection, languages, OutputChannel, workspace, WorkspaceEdit } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';
import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';

interface AssertDivideState {
  attemptedLines: Set<number>;
  originalDiagnostics: Diagnostic[];
  lastGeneratedLine?: number;
  attemptCount?: number;
}

export default class GenerateCommands {
  private static assertDivideStates = new Map<string, AssertDivideState>();
  private static diagnosticsListener: DiagnosticCollection;
  private static outputChannel: OutputChannel;

  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    this.diagnosticsListener = languages.createDiagnosticCollection('dafny');
    this.outputChannel = window.createOutputChannel('Dafny Assert-Divide');

    installer.context.subscriptions.push(commands.registerCommand(
      DafnyCommands.GenerateSketch,
      (args?: { sketchType: string }) => GenerateCommands.CreateCommand(client, args?.sketchType)));

    // Listen for diagnostic updates
    installer.context.subscriptions.push(
      languages.onDidChangeDiagnostics(() => {
        this.outputChannel.appendLine('Diagnostics changed, handling...');
        this.handleDiagnosticsChange(client);
      })
    );

    return new GenerateCommands();
  }

  private static async handleDiagnosticsChange(client: DafnyLanguageClient) {
    const editor = window.activeTextEditor;
    if (!editor) {
      this.outputChannel.appendLine('No active editor, skipping diagnostic handling');
      return;
    }

    const documentUri = editor.document.uri.toString();
    const state = this.assertDivideStates.get(documentUri);
    if (!state) {
      // Only log if we have verification errors
      const currentDiagnostics = this.diagnosticsListener.get(editor.document.uri) || [];
      const verificationDiagnostics = currentDiagnostics.filter(d => 
        d.message.includes('could not be proved') || 
        d.message.includes('assertion might not hold'));
      if (verificationDiagnostics.length > 0) {
        this.outputChannel.appendLine('Got verification errors but no assert-divide state active');
      }
      return;
    }

    const currentDiagnostics = this.diagnosticsListener.get(editor.document.uri) || [];
    const verificationDiagnostics = currentDiagnostics.filter(d => 
      d.message.includes('could not be proved') || 
      d.message.includes('assertion might not hold'));
    
    // Check if we have any verification errors
    if (verificationDiagnostics.length > 0) {
      this.outputChannel.appendLine('\nStill have verification errors:');
      verificationDiagnostics.forEach(d => {
        this.outputChannel.appendLine(`Error at line ${d.range.start.line + 1}: ${d.message}`);
      });

      // Increment attempt count
      state.attemptCount = (state.attemptCount || 0) + 1;
      
      if (state.attemptCount > 3) {
        this.outputChannel.appendLine('Too many attempts, stopping assert-divide');
        window.showInformationMessage('Assert-divide: Could not find a working assertion after 3 attempts');
        this.assertDivideStates.delete(documentUri);
        return;
      }

      // Try AI improvement for the first failing assertion
      const failingLine = verificationDiagnostics[0].range.start.line;
      this.outputChannel.appendLine(`Attempting to improve assertion at line ${failingLine + 1}`);
      await this.tryImproveAssertion(client, editor, documentUri, failingLine);
    } else {
      this.outputChannel.appendLine('\nAll assertions verified!');
      window.showInformationMessage('Assert-divide: Successfully verified!');
      this.assertDivideStates.delete(documentUri);
    }
  }

  private static async tryNextAssertion(
    client: DafnyLanguageClient, 
    editor: TextEditor, 
    state: AssertDivideState
  ) {
    this.outputChannel.appendLine('Trying to find next assertion point...');
    this.outputChannel.appendLine(`Current attempted lines: ${[...state.attemptedLines].join(', ')}`);
    this.outputChannel.appendLine(`Last generated line: ${state.lastGeneratedLine}`);

    // Find a gap between verified lines to insert an assert
    const nextLine = this.findNextAssertLine(editor, state);
    if (nextLine === null) {
      this.outputChannel.appendLine('No more gaps to try, ending assert-divide');
      this.assertDivideStates.delete(editor.document.uri.toString());
      return;
    }

    this.outputChannel.appendLine(`Found next line for assertion: ${nextLine}`);
    state.lastGeneratedLine = nextLine;
    state.attemptedLines.add(nextLine);

    // Generate assert at this line
    this.outputChannel.appendLine('Generating assertion...');
    await this.generateAssertAtLine(client, editor, nextLine);
  }

  private static async handleAssertDivide(editor: TextEditor, document: any, client: DafnyLanguageClient): Promise<any> {
    this.outputChannel.appendLine('\n=== Starting new assert-divide operation ===');
    this.outputChannel.show(); // Force show the output channel
    window.showInformationMessage('Starting assert-divide');
    
    const assertInfo = await this.extractAssertInfo(editor);
    if (!assertInfo) {
      this.outputChannel.appendLine('No valid assertion found at cursor');
      return null;
    }
    this.outputChannel.appendLine(`Found assertion: ${assertInfo.assertion} at line ${assertInfo.line}`);

    // Store initial state for verification feedback
    const documentUri = document.uri.toString();
    const currentDiagnostics = this.diagnosticsListener.get(document.uri) || [];
    this.outputChannel.appendLine(`Initial diagnostics count: ${currentDiagnostics.length}`);
    
    // Get current verification errors
    const verificationDiagnostics = currentDiagnostics.filter(d => 
      d.message.includes('could not be proved') || 
      d.message.includes('assertion might not hold'));
    
    if (verificationDiagnostics.length === 0) {
      this.outputChannel.appendLine('No verification errors found. Trying simple splitting first.');
    } else {
      this.outputChannel.appendLine(`Found ${verificationDiagnostics.length} verification errors.`);
      verificationDiagnostics.forEach(d => {
        this.outputChannel.appendLine(`Error at line ${d.range.start.line + 1}: ${d.message}`);
      });
    }

    // Initialize state
    this.assertDivideStates.set(documentUri, {
      attemptedLines: new Set(),  // Start empty
      originalDiagnostics: verificationDiagnostics,
      lastGeneratedLine: assertInfo.line,
      attemptCount: 0
    });

    // Try simple && splitting first
    const simpleAssert = assertInfo.assertion.split(' && ')[0];
    if (simpleAssert !== assertInfo.assertion) {
      this.outputChannel.appendLine('Found && pattern, trying simple split');
      const workspaceEdit = new WorkspaceEdit();
      workspaceEdit.insert(
        document.uri,
        new Position(assertInfo.line, 0),
        `    assert ${simpleAssert}; // Split of &&\n`
      );
      await workspace.applyEdit(workspaceEdit);
      await commands.executeCommand(DafnyCommands.Build);
    } else {
      // No && to split, try AI directly
      this.outputChannel.appendLine('No && pattern found, trying AI suggestion');
      await this.tryImproveAssertion(client, editor, documentUri, assertInfo.line);
    }

    return null;
  }

  private static async extractAssertInfo(editor: TextEditor): Promise<{line: number, assertion: string} | null> {
    const selection = editor.selection;
    const currentLine = editor.document.lineAt(selection.start.line);
    const text = currentLine.text;
    this.outputChannel.appendLine(`Examining line: ${text}`);

    if (!text.trim().startsWith("assert")) {
      this.outputChannel.appendLine("Line does not start with 'assert'");
      window.showInformationMessage("Please place cursor on an assert statement");
      return null;
    }

    const assertMatch = text.match(/assert\s+(.*?);/);
    if (!assertMatch) {
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

    for (let i = startLine; i < endLine; i++) {
      const lineText = editor.document.lineAt(i).text;
      if (i === line) {
        context += '>>> ' + lineText + ' <<<\n';
      } else {
        context += lineText + '\n';
      }
    }

    return context;
  }

  private static async tryImproveAssertion(client: DafnyLanguageClient, editor: TextEditor, documentUri: string, line: number): Promise<void> {
    this.outputChannel.appendLine('\nTryImproveAssertion called');

    const state = this.assertDivideStates.get(documentUri);
    if (!state || state.attemptedLines.has(line)) {
      this.outputChannel.appendLine('Skipping line ' + line + ' - already attempted');
      return;
    }

    const context = await this.getAssertionContext(editor, line);
    this.outputChannel.appendLine('Got context:\n' + context);
    
    // Construct prompt for AI completion
    const prompt = `Given the following Dafny verification context, suggest an intermediate assertion that would help prove the property. Focus on breaking down the complex assertion into simpler, logically necessary steps. Provide just the assertion without 'assert' keyword or semicolon.

Context:
${context}

Suggestion:`;

    this.outputChannel.appendLine('Sending AI prompt:\n' + prompt);
    
    try {
      this.outputChannel.appendLine('Calling client.generateSketch...');
      const result = await client.generateSketch({
        prompt,
        content: editor.document.getText(),
        sketchType: 'ai',
        position: new Position(line, 0),
        textDocument: { uri: documentUri }
      });

      if (result?.sketch) {
        this.outputChannel.appendLine('Got AI suggestion: ' + result.sketch);
        state.attemptedLines.add(line);  // Add to attempted lines after getting suggestion
        const workspaceEdit = new WorkspaceEdit();
        workspaceEdit.insert(
          editor.document.uri,
          new Position(line, 0),
          `    assert ${result.sketch}; // AI suggested\n`
        );
        await workspace.applyEdit(workspaceEdit);
        await commands.executeCommand(DafnyCommands.Build);
      } else {
        this.outputChannel.appendLine('No sketch returned from AI');
      }
    } catch (e) {
      this.outputChannel.appendLine('Error in tryImproveAssertion: ' + e);
    }
  }

  private static async insertIntermediateAssertion(editor: TextEditor, assertion: string): Promise<void> {
    const workspaceEdit = new WorkspaceEdit();
    const line = editor.selection.active.line;
    
    workspaceEdit.insert(
      editor.document.uri,
      new Position(line, 0),
      `    assert ${assertion}; // AI suggested\n`
    );

    await workspace.applyEdit(workspaceEdit);
    await commands.executeCommand(DafnyCommands.Build);
  }

  private static async insertIntermediateAssertions(document: any, assertInfo: {line: number, assertion: string}): Promise<void> {
    const workspaceEdit = new WorkspaceEdit();
    
    // For now, simple && splitting. Later we can make this smarter based on verification feedback
    const intermediateAssert = 
        `    // Intermediate step\n` +
        `    assert ${assertInfo.assertion.split(" && ")[0]};\n` +
        `    // Next step\n` +
        `    assert ${assertInfo.assertion};`;
    
    workspaceEdit.insert(
        document.uri,
        new Position(assertInfo.line, 0),
        intermediateAssert + '\n'
    );

    await workspace.applyEdit(workspaceEdit);
  }

  private static async triggerVerification(): Promise<void> {
    await commands.executeCommand(DafnyCommands.Build);
  }

  private static findNextAssertLine(editor: TextEditor, state: AssertDivideState): number | null {
    const startLine = state.lastGeneratedLine || 0;
    const endLine = editor.document.lineCount;
    const midLine = Math.floor((startLine + endLine) / 2);

    this.outputChannel.appendLine(`Searching for gap: start=${startLine}, end=${endLine}, mid=${midLine}`);

    if (state.attemptedLines.has(midLine) || midLine === startLine) {
      this.outputChannel.appendLine('No suitable gap found');
      return null;
    }

    return midLine;
  }

  private static async generateAssertAtLine(
    client: DafnyLanguageClient,
    editor: TextEditor,
    line: number
  ) {
    this.outputChannel.appendLine(`Generating assert at line ${line}`);
    const position = new Position(line, 0);
    await client.generateSketch({
      prompt: undefined,
      sketchType: 'assert_divide',
      position: position,
      textDocument: { uri: editor.document.uri.toString() },
      content: editor.document.getText()
    });
  }

  private static async CreateCommand(client: DafnyLanguageClient, preselectedType?: string) {
    const sketchType = preselectedType ?? await (async () => {
      const sketchTypes = await client.getSketchTypes();
      return window.showQuickPick(sketchTypes, {
        placeHolder: 'Select a sketch type',
        canPickMany: false
      });
    })();

    if(sketchType == null) {
      return null;
    }

    let prompt = undefined;
    if(sketchType === 'ai') {
      prompt = await window.showInputBox({
        prompt: 'Enter your AI prompt',
        placeHolder: 'Describe what you want to generate'
      });
    }

    const editor = window.activeTextEditor;
    if(editor == null) {
      window.showInformationMessage('editor is null');
      return null;
    }
    const document = editor.document;
    const content = document.getText();
    const position = editor.selection.active;
    if(document == null) {
      window.showInformationMessage('document is null');
      return null;
    }
    if(document.isUntitled) {
      window.showInformationMessage('document is untitled');
      commands.executeCommand(VSCodeCommands.SaveAs);
      return null;
    }


    // Check if this is an IDE-specific type
    if (sketchType === 'assert_divide') {
      return await this.handleAssertDivide(editor, document, client);

    }

    // Otherwise, pass to server as normal
    return client.generateSketch({ 
      prompt: prompt,
      content: content, 
      sketchType: sketchType, 
      position: position,
      textDocument: { uri: document.uri!.toString() }
    });
  }
}