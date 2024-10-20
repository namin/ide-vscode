import { window, commands } from 'vscode';
import { DafnyLanguageClient } from '../language/dafnyLanguageClient';

import { DafnyInstaller } from '../language/dafnyInstallation';
import { DafnyCommands, VSCodeCommands } from '../commands';

export default class GenerateCommands {
  public static createAndRegister(installer: DafnyInstaller, client: DafnyLanguageClient): GenerateCommands {
    installer.context.subscriptions.push(
      commands.registerCommand(DafnyCommands.GenerateInductiveProofSketch, () => {
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
        window.showInformationMessage('client.generate');
        return client.generateInductiveProofSketch({ position: position, textDocument: { uri: document.uri!.toString() } });
      }));
    return new GenerateCommands();
  }
}