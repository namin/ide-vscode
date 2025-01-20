import { window, commands } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';

import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';
import { ExtensionContext } from 'vscode';

export default class GenerateCommands {
  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    installer.context.subscriptions.push(commands.registerCommand(
      DafnyCommands.GenerateSketch,
      (args?: { sketchType: string }) => GenerateCommands.CreateCommand(client, args?.sketchType)));
    return new GenerateCommands();
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
    //if(!await document.save()) {
    //  return null;
    //}
    return client.generateSketch({ prompt: prompt, content: content, sketchType: sketchType, position: position, textDocument: { uri: document.uri!.toString() } });
  }
}

