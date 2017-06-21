var fs = require('fs-extra');
var fspath = require("path");
var filter = require('filter-files');

var settings_config = 'storageModule: require("node-red-contrib-mf-flows_splitter"),';

if (fs.existsSync("../../settings.js")) {

}

var files = filter.sync("../..", function (fp) {
    return new RegExp("settings\.js$", "g").test(fp);
});

console.log(files);