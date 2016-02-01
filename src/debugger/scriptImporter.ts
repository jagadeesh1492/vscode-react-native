// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import fs = require("fs");
import {Log} from "../utils/commands/log";
import path = require("path");
import Q = require("q");
import {Request} from "../utils/node/request";
import url = require("url");
import vm = require("vm");

interface ISourceMap {
    file: string;
    sources: string[];
    version: number;
    names: string[];
    mappings: string;
    sourceRoot?: string;
    sourcesContent?: string[];
}

export class ScriptImporter {
    private projectRootPath: string;
    private bundleFolderPath: string;

    constructor(projectRootPath: string) {
        this.projectRootPath = projectRootPath;
        // We put the source code inside the workspace, because VS Code doesn't seem to support source mapping if we don't do that
        this.bundleFolderPath = path.join(this.projectRootPath, ".vscode");
    }

    public import(scriptUrlString: string): Q.Promise<void> {

        // We'll get the source code, and store it locally to have a better debugging experience
        return new Request().request(scriptUrlString, true).then(scriptBody => {
            // Extract sourceMappingURL from body
            let scriptUrl = url.parse(scriptUrlString); // scriptUrl = "http://localhost:8081/index.ios.bundle?platform=ios&dev=true"
            let sourceMappingUrl = this.getSourceMapURL(scriptUrl, scriptBody); // sourceMappingUrl = "http://localhost:8081/index.ios.map?platform=ios&dev=true"

            if (sourceMappingUrl) {
                /* handle source map - request it and store it locally */
                return this.writeSourceMap(sourceMappingUrl, scriptUrl)
                    .then(() => {
                        scriptBody = this.updateScriptPaths(scriptBody, sourceMappingUrl);
                        return this.writeScript(scriptBody, scriptUrl);
                    })
                    .then((scriptFilePath: string) => this.runScript(scriptBody, scriptFilePath));
            } else {
                /* source map not specified - write the source file as is */
                return this.writeScript(scriptBody, scriptUrl)
                    .then((scriptFilePath: string) => this.runScript(scriptBody, scriptFilePath));
            }
        });
    }

    /**
     * Updates source map URLs in the script body.
     */
    private updateScriptPaths(scriptBody: string, sourceMappingUrl: url.Url) {
        // Update the body with the new location of the source map on storage.
        return scriptBody.replace(/^\/\/# sourceMappingURL=(.*)$/m, "//# sourceMappingURL=" + path.basename(sourceMappingUrl.path));
    }

    /**
     * Updates paths in souce maps - VS code requires forward slash paths.
     */
    private updateSourceMapPaths(sourceMapBody: string, generatedCodeFilePath: string): string {
        try {
            let sourceMap = <ISourceMap>JSON.parse(sourceMapBody);
            sourceMap.sources = sourceMap.sources.map(source => {
                // Make all paths relative to the location of the source map
                let relativeSourcePath = path.relative(this.bundleFolderPath, source);
                let sourceUrl = relativeSourcePath.replace(/\\/g, "/");
                return sourceUrl;
            });
            // fixedSourceMapBody.sourceRoot = "..";
            delete sourceMap.sourcesContent;
            sourceMap.sourceRoot = "";
            sourceMap.file = generatedCodeFilePath;
            return JSON.stringify(sourceMap);
        } catch (exception) {
            return sourceMapBody;
        }
    }

    /**
     * Runs a script in the node context.
     */
    private runScript(code: string, fileName: string) {
        // The next line converts to any due to the incorrect typing on node.d.ts of vm.runInThisContext
        vm.runInThisContext(code, <any>{ filename: fileName });
    }

    /**
     * Writes the script file to the project temporary location.
     */
    private writeScript(scriptBody: string, scriptUrl: url.Url): Q.Promise<String> {
        return Q.fcall(() => {
            let scriptFilePath = path.join(this.bundleFolderPath, scriptUrl.pathname); // scriptFilePath = "$TMPDIR/index.ios.bundle"
            this.writeTemporaryFileSync(scriptFilePath, scriptBody);
            // Log.logMessage("Imported script at " + scriptUrl.path + " locally stored on " + scriptFilePath);
            return scriptFilePath;
        });
    }

    /**
     * Writes the source map file to the project temporary location.
     */
    private writeSourceMap(sourceMapUrl: url.Url, scriptUrl: url.Url): Q.Promise<void> {
        return new Request().request(sourceMapUrl.href, true)
            .then((sourceMapBody: string) => {
                let sourceMappingLocalPath = path.join(this.bundleFolderPath, sourceMapUrl.path); // sourceMappingLocalPath = "$TMPDIR/index.ios.map?platform=ios&dev=true"
                let scriptFileRelativePath = path.basename(scriptUrl.pathname); // scriptFileRelativePath = "index.ios.bundle"
                this.writeTemporaryFileSync(sourceMappingLocalPath, this.updateSourceMapPaths(sourceMapBody, scriptFileRelativePath));
            });
    }

    /**
     * Given a script body and URL, this method parses the body and finds the corresponding source map URL.
     * If the source map URL is not found in the body in the expected form, null is returned.
     */
    private getSourceMapURL(scriptUrl: url.Url, scriptBody: string): url.Url {
        let result: url.Url = null;

        // scriptUrl = "http://localhost:8081/index.ios.bundle?platform=ios&dev=true"
        let sourceMappingRelativeUrl = this.sourceMapRelativeUrl(scriptBody); // sourceMappingRelativeUrl = "/index.ios.map?platform=ios&dev=true"
        if (sourceMappingRelativeUrl) {
            let sourceMappingUrl = url.parse(sourceMappingRelativeUrl);
            sourceMappingUrl.protocol = scriptUrl.protocol;
            sourceMappingUrl.host = scriptUrl.host;
            // parse() repopulates all the properties of the URL
            result = url.parse(url.format(sourceMappingUrl));
        }

        return result;
    }

    /**
     * Parses the body of a script searching for a source map URL.
     * Returns the first match if found, null otherwise.
     */
    private sourceMapRelativeUrl(body: string) {
        let match = body.match(/^\/\/# sourceMappingURL=(.*)$/m);
        // If match is null, the body doesn't contain the source map
        return match ? match[1] : null;
    }

    private writeTemporaryFileSync(filename: string, data: string): Q.Promise<void> {
        let writeFile = Q.nfbind<void>(fs.writeFile);

        return writeFile(filename, data)
            .then(() => this.scheduleTemporaryFileCleanUp(filename));
    }

    private scheduleTemporaryFileCleanUp(filename: string): void {
        process.on("exit", function() {
            let unlink = Q.nfbind<void>(fs.unlink);
            unlink(filename)
                .then(() => {
                    Log.logMessage("Succesfully cleaned temporary file: " + filename);
                });
        });
    }
}
