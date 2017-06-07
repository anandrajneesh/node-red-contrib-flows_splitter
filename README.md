# node-red-contrib-mf-flows_splitter
Allow flows .json to be split in multiple local file

## Instructions
add this in settings
```
storageModule: require("node-red-contrib-mf-flows_splitter"), 
```

## known bugs :
* When we save less tabs than the previours deploy, we need to delete previous flows (but not the backups) and save 
* ~~first time you need to restart the node-red twice to be have all your tabs. fixable~~
