const path = require('path');
const express = require('express');
const serverApp = require('../server');

const ROOT = path.resolve(__dirname, '..');
serverApp.use(express.static(ROOT));
serverApp.use('/admin', express.static(path.join(ROOT, 'admin')));

module.exports = serverApp;
