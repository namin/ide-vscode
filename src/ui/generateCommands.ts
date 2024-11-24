import { window, commands } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';

import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';
import { IAiCompletionResponse } from '../language/api/aiCompletionResponse';

export default class GenerateCommands {
  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {

    installer.context.subscriptions.push(commands.registerCommand(
      DafnyCommands.GenerateProofSketch,
      () => GenerateCommands.CreateCommand(client)));
    installer.context.subscriptions.push(
      commands.registerCommand(DafnyCommands.GenerateAiCompletion, async () => {
        const editor = window.activeTextEditor;
        if(!editor) {
          window.showErrorMessage('No active text editor.');
          return;
        }

        const document = editor.document;
        const selection = editor.selection;
        const selectedText = document.getText(selection);

        // Extract relevant context
        const contextText = document.getText();
        const userPrompt = await window.showInputBox({
          prompt: 'Enter your AI prompt',
          placeHolder: 'Describe what you want to generate'
        });

        if(!userPrompt) {
          window.showErrorMessage('No prompt provided.');
          return;
        }

        const insertionPoint = `Selected range: Line ${selection.start.line + 1} to ${selection.end.line + 1}`;

        const result = await client.sendRequest<IAiCompletionResponse>('dafny/aiCompletion', {
          context: "Dafny code:\n"+contextText+"\n"+insertionPoint,
          userPrompt: userPrompt
        });

        window.showInformationMessage("result: " + result.completion);

        // Insert the result into the editor
        if(result) {
          editor.edit((editBuilder) => {
            editBuilder.replace(selection, result.completion);
          });
        } else {
          window.showErrorMessage('No completion result received.');
        }
      }));
    return new GenerateCommands();
  }

  private static async CreateCommand(client: DafnyLanguageClient) {
    const sketchTypes = await client.getProofSketchTypes();
    const sketchType = await window.showQuickPick(sketchTypes, {
      placeHolder: 'Select a sketch type',
      canPickMany: false
    });
    if(sketchType == null) {
      return null;
    }
    const editor = window.activeTextEditor;
    if(editor == null) {
      window.showInformationMessage('editor is null');
      return null;
    }
    const document = editor.document;
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
    //if(!await document.save()) {
    //  return null;
    //}
    return client.generateProofSketch({ sketchType: sketchType, position: position, textDocument: { uri: document.uri!.toString() } });
  }
}

