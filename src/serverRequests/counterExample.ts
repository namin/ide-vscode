"use strict";
import * as vscode from "vscode";
import { LanguageClient, ResponseError } from "vscode-languageclient";

import {
  LanguageServerRequest,
  Error,
} from "../stringRessources/_StringRessourcesModule";
import {
  ICounterExamples,
  ICounterExampleArguments,
} from "../typeInterfaces/_TypeInterfacesModule";

import { ICounterExample } from "./ICounterExample";

/**
 * Provides Counter Example provided by the Dafny language server.
 */
export class CounterExample implements ICounterExample {
  private static timeout: NodeJS.Timer;
  private readonly maxRequestsPerSecond: number = 2; // todo config?
  private readonly oneSecInMs: number = 1000;

  private languageServer: LanguageClient;

  constructor(languageServer: LanguageClient) {
    this.languageServer = languageServer;
  }

  public getCounterExample(
    callback: Function,
    isAutoTriggered: boolean = false
  ) {
    if (!vscode.window.activeTextEditor) {
      return;
    }
    const arg: ICounterExampleArguments = {
      DafnyFile: vscode.window.activeTextEditor.document.fileName,
    };
    vscode.window.activeTextEditor.document.save().then(() => {
      // This timeout makes sure, that max 2 server requests each second were sent.
      // Otherwise - if a user would tipping verry fast - there would be a request overhead.
      clearTimeout(CounterExample.timeout);
      const boundThis = this;
      CounterExample.timeout = setTimeout(
        function () {
          boundThis.languageServer
            .sendRequest<ICounterExamples>(
              LanguageServerRequest.CounterExample,
              arg
            )
            .then(
              (allCounterExamples: ICounterExamples) => {
                callback(allCounterExamples, isAutoTriggered);
              },
              (error: ResponseError<void>) => {
                vscode.window.showErrorMessage(
                  `${Error.CanNotGetCounterExample}: ${error.message}`
                );
              }
            );
        },
        isAutoTriggered ? this.oneSecInMs / this.maxRequestsPerSecond : 1
      );
    });
  }
}