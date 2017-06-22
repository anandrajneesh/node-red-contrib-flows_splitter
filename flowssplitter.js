var fs = require('fs-extra');
var when = require('when');
var nodeFn = require('when/node/function');
var keys = require('when/keys');
var fspath = require("path");
var mkdirp = fs.mkdirs;

var filter = require('filter-files')

var log = require("../node-red/red/runtime/log");

var promiseDir = nodeFn.lift(mkdirp);

var initialFlowLoadComplete = false;
var settings;

const type_tab_name = "tab";
const type_subflow_name = "subflow";
var types_to_split = [type_tab_name, type_subflow_name];

var flowsFile;
var flowsFullPath;
var flowsFileBackup;


var credentialsFile;
var credentialsFileBackup;
var oldCredentialsFile;
var sessionsFile;
var libDir;
var libFlowsDir;
var globalSettingsFile;

Array.prototype.contains = function (element) {
    return this.indexOf(element) > -1;
};

function writeFlows(flows) {

    var ffExt = fspath.extname(flowsFullPath);
    var ffName = fspath.basename(flowsFullPath);
    var ffBase = fspath.basename(flowsFullPath, ffExt);
    var ffDir = fspath.dirname(flowsFullPath);

    return when.promise(function (resolve, reject) {

        var _orphans = [];
        var _tabs = {};
        var _tabs_order = [];
        var _subflows = {};

        // find out how to split into sections
        flows.forEach(function (flowElements) {
            var flowElementsStr = JSON.stringify(flowElements);

            if (flowElements.type == type_tab_name) {
                _tabs[flowElements.id] = [];
                _tabs[flowElements.id].push(flowElements);
                _tabs_order.push(flowElements.id);
            }

            if (flowElements.type == type_subflow_name) {
                _subflows[flowElements.id] = [];
                _subflows[flowElements.id].push(flowElements);
            }

        });

        // save items component in the right section
        flows.forEach(function (flowElements) {

            // item in types_to_split are already taken care of before
            if (types_to_split.contains(flowElements.type))
                return;

            // orphan
            if (!flowElements.z) {
                _orphans.push(flowElements);
                return;
            }

            // linked to a tab
            if (flowElements.z in _tabs) {
                _tabs[flowElements.z].push(flowElements);
                return;
            }

            //linked to a subflow
            if (flowElements.z in _subflows) {
                _subflows[flowElements.z].push(flowElements);
                return;
            }

            console.warn(`Element ${flowElements.id} is not linked to any section but still contains a z of '${flowElements.z}'`);
        });

        var files_to_write = {};
        var promises = [];

        // orphans
        if (_orphans.length > 0) {

            var file_path = fspath.join(ffDir, ffBase + '_orphans' + ffExt);
            var file_content = _orphans;

            console.log(`saved ${_orphans.length} orphan(s) to '${file_path}'`);
            files_to_write[file_path] = file_content;
        }

        // tabs
        var tab_idx = 0;
        _tabs_order.forEach(function (tab_id) {

            var file_path = fspath.join(ffDir, ffBase + '_tab_' + (++tab_idx) + ffExt);
            var file_content = _tabs[tab_id];

            console.log(`saved tab index ${tab_idx} with ${file_content.length} element(s) to '${file_path}'`);
            files_to_write[file_path] = file_content;
        });

        // subflows
         Object.keys(_subflows).forEach(function (key) {

            var file_path = fspath.join(ffDir, `${ffBase}_subflow_${key}${ffExt}`);
            var file_content = _subflows[key];

            console.log(`saved subflow id ${key} with ${file_content.length} element(s) to '${file_path}'`);
            files_to_write[file_path] = file_content;
        });

        // create promises for every file
        Object.keys(files_to_write).forEach(function (key) {

            var file_path = key;
            var file_contentStr = files_to_write[key];

            var file_content = JSON.stringify(file_contentStr);
            if (settings.flowFilePretty)
                file_content = JSON.stringify(file_contentStr, null, 4);

            try {
                fs.renameSync(file_path, file_path + ".backup");
            } catch (err) {}

            promises.push(writeFile(file_path, file_content));
        });

        when.all(promises).then(() => {
            resolve();
        });
    });
}

function readFlows() {
    var ffExt = fspath.extname(flowsFullPath);
    var ffName = fspath.basename(flowsFullPath);
    var ffBase = fspath.basename(flowsFullPath, ffExt);
    var ffDir = fspath.dirname(flowsFullPath);

    return when.promise((resolve, reject) => {

        if (!initialFlowLoadComplete) {
            initialFlowLoadComplete = true;

            log.info(log._("storage.localfilesystem.user-dir", {
                path: settings.userDir
            }));
            log.info(log._("storage.localfilesystem.flows-file", {
                path: flowsFullPath
            }));

            if (fs.existsSync(flowsFullPath)) {
                readFile(flowsFullPath, flowsFileBackup, [], 'flow').then(function (flows) {
                    fs.unlink(flowsFullPath);
                    return writeFlows(flows);
                }).then(() => {
                    resolve();
                })
                return;
            }
        }
        console.log('skip');
        resolve();
    }).then(() => {
        return when.promise((resolve, reject) => {
            function escapeRegExp(str) {
                return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
            }
            var promises = [];

            // tabs
            var tab_regex_filter = escapeRegExp(ffBase) + "_tab_\\d+" + escapeRegExp(ffExt) + "$";
            var tab_files = filter.sync(ffDir, function (fp) {
                return new RegExp(tab_regex_filter, "g").test(fp);
            });
            tab_files.forEach(function (flow_tab) {
                promises.push(readFile(flow_tab, flow_tab + ".backup", [], 'flow'));
            });

            // subflows
            var subflow_regex_filter = escapeRegExp(ffBase) + "_subflow_.+" + escapeRegExp(ffExt) + "$";
            var subflow_files = filter.sync(ffDir, function (fp) {
                return new RegExp(subflow_regex_filter, "g").test(fp);
            });
            subflow_files.forEach(function (subflow) {
                promises.push(readFile(subflow, subflow + ".backup", [], 'flow'));
            });

            // orphan
            var orphan_filename = ffBase + '_orphans' + ffExt;
            var orphan_filepath = fspath.join(ffDir, orphan_filename);
            if (fs.existsSync(orphan_filepath))
                promises.push(readFile(orphan_filepath, orphan_filepath + ".backup", [], 'flow'));

            return when.all(promises).then(values => {
                var flows = [];
                values.forEach(function (elements) {
                    elements.forEach(function (tab_component) {
                        flows.push(tab_component);
                    });
                });
                resolve(flows);
            });
        });
    });
}

function getFileMeta(root, path) {
    var fn = fspath.join(root, path);
    var fd = fs.openSync(fn, "r");
    var size = fs.fstatSync(fd).size;
    var meta = {};
    var read = 0;
    var length = 10;
    var remaining = "";
    var buffer = Buffer(length);
    while (read < size) {
        read += fs.readSync(fd, buffer, 0, length);
        var data = remaining + buffer.toString();
        var parts = data.split("\n");
        remaining = parts.splice(-1);
        for (var i = 0; i < parts.length; i += 1) {
            var match = /^\/\/ (\w+): (.*)/.exec(parts[i]);
            if (match) {
                meta[match[1]] = match[2];
            } else {
                read = size;
                break;
            }
        }
    }
    fs.closeSync(fd);
    return meta;
}

function getFileBody(root, path) {
    var body = "";
    var fn = fspath.join(root, path);
    var fd = fs.openSync(fn, "r");
    var size = fs.fstatSync(fd).size;
    var scanning = true;
    var read = 0;
    var length = 50;
    var remaining = "";
    var buffer = Buffer(length);
    while (read < size) {
        var thisRead = fs.readSync(fd, buffer, 0, length);
        read += thisRead;
        if (scanning) {
            var data = remaining + buffer.slice(0, thisRead).toString();
            var parts = data.split("\n");
            remaining = parts.splice(-1)[0];
            for (var i = 0; i < parts.length; i += 1) {
                if (!/^\/\/ \w+: /.test(parts[i])) {
                    scanning = false;
                    body += parts[i] + "\n";
                }
            }
            if (!/^\/\/ \w+: /.test(remaining)) {
                scanning = false;
            }
            if (!scanning) {
                body += remaining;
            }
        } else {
            body += buffer.slice(0, thisRead).toString();
        }
    }
    fs.closeSync(fd);
    return body;
}

/**
 * Write content to a file using UTF8 encoding.
 * This forces a fsync before completing to ensure
 * the write hits disk.
 */
function writeFile(path, content) {
    return when.promise(function (resolve, reject) {
        var stream = fs.createWriteStream(path);
        stream.on('open', function (fd) {
            stream.end(content, 'utf8', function () {
                fs.fsync(fd, resolve);
            });
        });
        stream.on('error', function (err) {
            reject(err);
        });
    });
}

function readFile(path, backupPath, emptyResponse, type) {
    return when.promise(function (resolve) {
        fs.readFile(path, 'utf8', function (err, data) {
            if (!err) {
                if (data.length === 0) {
                    log.warn(log._("storage.localfilesystem.empty", {
                        type: type
                    }));
                    try {
                        var backupStat = fs.statSync(backupPath);
                        if (backupStat.size === 0) {
                            // Empty flows, empty backup - return empty flow
                            return resolve(emptyResponse);
                        }
                        // Empty flows, restore backup
                        log.warn(log._("storage.localfilesystem.restore", {
                            path: backupPath,
                            type: type
                        }));
                        fs.copy(backupPath, path, function (backupCopyErr) {
                            if (backupCopyErr) {
                                // Restore backup failed
                                log.warn(log._("storage.localfilesystem.restore-fail", {
                                    message: backupCopyErr.toString(),
                                    type: type
                                }));
                                resolve([]);
                            } else {
                                // Loop back in to load the restored backup
                                resolve(readFile(path, backupPath, emptyResponse, type));
                            }
                        });
                        return;
                    } catch (backupStatErr) {
                        // Empty flow file, no back-up file
                        return resolve(emptyResponse);
                    }
                }
                try {
                    return resolve(JSON.parse(data));
                } catch (parseErr) {
                    log.warn(log._("storage.localfilesystem.invalid", {
                        type: type
                    }));
                    return resolve(emptyResponse);
                }
            } else {
                if (type === 'flow') {
                    log.info(log._("storage.localfilesystem.create", {
                        type: type
                    }));
                }
                resolve(emptyResponse);
            }
        });
    });
}

var flowssplitter = {
    init: function (_settings) {
        settings = _settings;

        var promises = [];

        if (!settings.userDir) {
            try {
                fs.statSync(fspath.join(process.env.NODE_RED_HOME, ".config.json"));
                settings.userDir = process.env.NODE_RED_HOME;
            } catch (err) {
                settings.userDir = fspath.join(process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE || process.env.NODE_RED_HOME, ".node-red");
                if (!settings.readOnly) {
                    promises.push(promiseDir(fspath.join(settings.userDir, "node_modules")));
                }
            }
        }

        if (settings.flowFile) {
            flowsFile = settings.flowFile;
            // handle Unix and Windows "C:\"
            if ((flowsFile[0] == "/") || (flowsFile[1] == ":")) {
                // Absolute path
                flowsFullPath = flowsFile;
            } else if (flowsFile.substring(0, 2) === "./") {
                // Relative to cwd
                flowsFullPath = fspath.join(process.cwd(), flowsFile);
            } else {
                try {
                    fs.statSync(fspath.join(process.cwd(), flowsFile));
                    // Found in cwd
                    flowsFullPath = fspath.join(process.cwd(), flowsFile);
                } catch (err) {
                    // Use userDir
                    flowsFullPath = fspath.join(settings.userDir, flowsFile);
                }
            }

        } else {
            flowsFile = 'flows_' + require('os').hostname() + '.json';
            flowsFullPath = fspath.join(settings.userDir, flowsFile);
        }
        var ffExt = fspath.extname(flowsFullPath);
        var ffName = fspath.basename(flowsFullPath);
        var ffBase = fspath.basename(flowsFullPath, ffExt);
        var ffDir = fspath.dirname(flowsFullPath);

        credentialsFile = fspath.join(settings.userDir, ffBase + "_cred" + ffExt);
        credentialsFileBackup = fspath.join(settings.userDir, "." + ffBase + "_cred" + ffExt + ".backup");

        oldCredentialsFile = fspath.join(settings.userDir, "credentials.json");

        flowsFileBackup = fspath.join(ffDir, "." + ffName + ".backup");

        sessionsFile = fspath.join(settings.userDir, ".sessions.json");

        libDir = fspath.join(settings.userDir, "lib");
        libFlowsDir = fspath.join(libDir, "flows");

        globalSettingsFile = fspath.join(settings.userDir, ".config.json");

        if (!settings.readOnly) {
            promises.push(promiseDir(libFlowsDir));
        }

        return when.all(promises);
    },

    getFlows: function () {
        //return readFile(flowsFullPath, flowsFileBackup, [], 'flow');

        return readFlows();
    },

    saveFlows: function (flows) {

        if (settings.readOnly) {
            return when.resolve();
        }

        return writeFlows(flows);
    },

    getCredentials: function () {
        return readFile(credentialsFile, credentialsFileBackup, {}, 'credentials');
    },

    saveCredentials: function (credentials) {
        if (settings.readOnly) {
            return when.resolve();
        }

        try {
            fs.renameSync(credentialsFile, credentialsFileBackup);
        } catch (err) {}
        var credentialData;
        if (settings.flowFilePretty) {
            credentialData = JSON.stringify(credentials, null, 4);
        } else {
            credentialData = JSON.stringify(credentials);
        }
        return writeFile(credentialsFile, credentialData);
    },

    getSettings: function () {
        return when.promise(function (resolve, reject) {
            fs.readFile(globalSettingsFile, 'utf8', function (err, data) {
                if (!err) {
                    try {
                        return resolve(JSON.parse(data));
                    } catch (err2) {
                        log.trace("Corrupted config detected - resetting");
                    }
                }
                return resolve({});
            })
        })
    },
    saveSettings: function (newSettings) {
        if (settings.readOnly) {
            return when.resolve();
        }
        return writeFile(globalSettingsFile, JSON.stringify(newSettings, null, 1));
    },
    getSessions: function () {
        return when.promise(function (resolve, reject) {
            fs.readFile(sessionsFile, 'utf8', function (err, data) {
                if (!err) {
                    try {
                        return resolve(JSON.parse(data));
                    } catch (err2) {
                        log.trace("Corrupted sessions file - resetting");
                    }
                }
                resolve({});
            })
        });
    },
    saveSessions: function (sessions) {
        if (settings.readOnly) {
            return when.resolve();
        }
        return writeFile(sessionsFile, JSON.stringify(sessions));
    },

    getLibraryEntry: function (type, path) {
        var root = fspath.join(libDir, type);
        var rootPath = fspath.join(libDir, type, path);

        // don't create the folder if it does not exist - we are only reading....
        return nodeFn.call(fs.lstat, rootPath).then(function (stats) {
            if (stats.isFile()) {
                return getFileBody(root, path);
            }
            if (path.substr(-1) == '/') {
                path = path.substr(0, path.length - 1);
            }
            return nodeFn.call(fs.readdir, rootPath).then(function (fns) {
                var dirs = [];
                var files = [];
                fns.sort().filter(function (fn) {
                    var fullPath = fspath.join(path, fn);
                    var absoluteFullPath = fspath.join(root, fullPath);
                    if (fn[0] != ".") {
                        var stats = fs.lstatSync(absoluteFullPath);
                        if (stats.isDirectory()) {
                            dirs.push(fn);
                        } else {
                            var meta = getFileMeta(root, fullPath);
                            meta.fn = fn;
                            files.push(meta);
                        }
                    }
                });
                return dirs.concat(files);
            });
        }).otherwise(function (err) {
            // if path is empty, then assume it was a folder, return empty
            if (path === "") {
                return [];
            }

            // if path ends with slash, it was a folder
            // so return empty
            if (path.substr(-1) == '/') {
                return [];
            }

            // else path was specified, but did not exist,
            // check for path.json as an alternative if flows
            if (type === "flows" && !/\.json$/.test(path)) {
                return localfilesystem.getLibraryEntry(type, path + ".json")
                    .otherwise(function (e) {
                        throw err;
                    });
            } else {
                throw err;
            }
        });
    },

    saveLibraryEntry: function (type, path, meta, body) {
        if (settings.readOnly) {
            return when.resolve();
        }
        var fn = fspath.join(libDir, type, path);
        var headers = "";
        for (var i in meta) {
            if (meta.hasOwnProperty(i)) {
                headers += "// " + i + ": " + meta[i] + "\n";
            }
        }
        if (type === "flows" && settings.flowFilePretty) {
            body = JSON.stringify(JSON.parse(body), null, 4);
        }
        return promiseDir(fspath.dirname(fn)).then(function () {
            writeFile(fn, headers + body);
        });
    }
};

module.exports = flowssplitter;