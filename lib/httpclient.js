var util = require('util');
var net = require('net');
var events = require('events');
var crypto = require('crypto');
var httpoutgoing = require('httpoutgoing');
var parsers = require('httpparser').parsers;
var assert = process.assert;

var debugLevel = parseInt(process.env.NODE_DEBUG, 16);

function debug () {
  if (debugLevel & 0x4) {
    util.error.apply(this, arguments);
  }
}

var STATE_CLOSED = 0;
var STATE_OPENING = 1;
var STATE_OPEN = 2;
var STATE_DEAD = 3;

function Client(port, host, https, credentials) {
  if (!(this instanceof Client)) {
    return new Client(port, host, https, credential);
  }

  events.EventEmitter.call(this);

  this.host = host;
  this.port = port;
  this.https = https;
  this.credentials = credentials ? credentials : {};

  this._children = [];
  this._destroyOnDrain = false;

  this._state = STATE_CLOSED;

  this._stream = null;

  this._establishStreams();
}

util.inherits(Client, events.EventEmitter);
exports.Client = Client;

exports.createClient = function (port, host, https, credentials) {
  var c = new Client(port, host, https, credentials);
  return c;
};

/* This is split out incase we are disconnected after a request,
 * Which is a fairly common situation in node, so we reestablish everyhting.
 */
Client.prototype._establishStreams = function() {
  var self = this;

  this._netstream = new net.createConnection(this.port, this.host);
  this._state = STATE_OPENING;

  if (!this.https) {
    this._stream = this._netstream;
    this._netstream.on('connect', function() {
      self._transportConnected();
    });

  } else {
    if (!this.credentials.hostname) {
      /* Add ServerNameIndication hostname if not present. */
      this.credentials.hostname = this.host;
    }

    if (!(this.credentials instanceof crypto.Credentials)) {
      this.credentials = crypto.createCredentials(this.credentials);
    }

    this._securePair = crypto.createPair(this.credentials);

    this._securePair.encrypted.pipe(this._netstream);
    this._netstream.pipe(this._securePair.encrypted);

    this._stream = this._securePair.cleartext;
    
    this._securePair.on('secure', function() {
      self._transportConnected();
    });

    this._securePair.on('error', function(err) {
      self._transportError(err);
    });

    this._securePair.on('end', function(err) {
      self._transportEnd(err);
    });
  }

  this._netstream.on('error', function(err) {
    self._transportError(err);
  });

  this._netstream.on('end', function() {
    self._transportEnd();
  });

  this._stream.on('data', function(chunk) {
    self._transportData(chunk);
  });

  this._stream.on('resume', function() {
    self._transportResume();
  });

  this._stream.on('pause', function() {
    self._transportPause();
  });

  if (!this._parser) {
    this._parser = parsers.alloc();
  }

  this._parser.reinitialize('response');
  this._parser.socket = this;
  this._parser.onIncoming = function(res) {
    return self._incomingResponse(res);
  };
};

Client.prototype._destroyStreams = function() {
  this._state = STATE_CLOSED;

  if (this._nestream) {
    this._netstream.destroy();
    delete this._netstream;
  }

  if (this._securePair) {
    this._securePair.destroy();
    delete this._securePair;
  }
};

Client.prototype.destroy = function () {
  this._destroyStreams();
  parsers.free(this.parser);
  this.parser = null;
}

Client.prototype.request = function (method, url, headers) {
  if (typeof(url) != "string") {
    // assume method was omitted, shift arguments
    headers = url;
    url = method;
    method = "GET";
  }

  var req = new httpoutgoing.ClientRequest(this, method, url, headers);

  this._children.push(req);

  return req;
};

Client.prototype._transportConnected = function() {
  this._state = STATE_OPEN;
  if (this._children.length) {
    this._childFlush(this._children[0]);
  }
};

Client.prototype._transportError = function(err) {
  this._state = STATE_DEAD;
  this.emit('error', err);
};

Client.prototype._transportEnd = function() {
  this._state = STATE_CLOSED;

  if (this._children.length) {
    /* TODO: For HTTP Pipelining, this will need major work to retransmit requests. */
    /* TODO: Layering violation */
    var child = this._children[0];

    if (child._dataSent) {
      /* TODO: what should we do? */
      //child.emit('error', new Error('Transport ended while request was ongoing.'));
    } else {
      /* Okay, never sent any data yet, or we are between requests, reconnect and start over. */
      this._destroyStreams();
      this._establishStreams();
    }
  }
};

Client.prototype._transportData = function(chunk) {
  if (!this._children.length) {
    throw new Error('Weird. Got Data from the trnasport, but we do not have any children requests?');
  }

  var ret = this._parser.execute(chunk, 0, chunk.length);

  if (ret instanceof Error) {
    this.destroy(ret);
    return;
  }

  if (this._parser.incoming && this._parser.incoming.upgrade) {
    var bytesParsed = ret;
    var req = this._parser.incoming;

    var upgradeHead = chunk.slice(bytesParsed + 1, chunk.length);

    if (this.listeners('upgrade').length) {
      this.emit('upgrade', req, self, upgradeHead);
    } else {
      this.destroy(new Error('Request should of been upgraded, but no listeners found?'));
    }
  }
};

Client.prototype._transportResume = function() {
  /* TODO: resume child */
};

Client.prototype._transportPause = function() {
  /* TODO: tell child to shut the fuck up */
};

Client.prototype._incomingResponse = function(res) {
  debug("incoming response!");
  var self =  this;
  var req = this._children[0];

  // Responses to HEAD requests are AWFUL. Ask Ryan.
  // A major oversight in HTTP. Hence this nastiness.
  var isHeadResponse = req.method == "HEAD";
  debug('isHeadResponse ' + isHeadResponse);

  if (res.statusCode == 100) {
    // restart the parser, as this is a continue message.
    req.emit("continue");
    return true;
  }

  if (req.shouldKeepAlive && res.headers.connection === 'close') {
    req.shouldKeepAlive = false;
  }

  res.on('end', function () {
    debug("request complete disconnecting.");
    self._childDone(req);
  });

  req.emit("response", res);

  return isHeadResponse;
};

Client.prototype._childFlush = function(child) {
  if (child._parentBuffer.length) {
    child._parentBuffer.forEach(function(item) {
      this._stream.write(item);
    });
    child._parentBuffer.length = 0;
  }
};

Client.prototype._childWrite = function(child, buf) {
  if (child != this._children[0]) {
    /* UGH, someone is writing to a child who isn't at the front of the line yet.
     * We now buffer it, and hopefully someday later we can deal with it.
     */
     child._parentBuffer.push(buf);
     return false;
  }

  this._childFlush(child);

  return this._stream.write(buf);
};

Client.prototype._childAllSent = function(child) {
  /* TODO: child has finished sending request, ready for a response */
  /* TODO: HTTP pipelining changes would go here */
};

Client.prototype._childDone = function(child, error) {
  assert(child == this._children[0]);

  this._children.shift();

  if (child.shouldKeepAlive && this._children.length) {
    this._childFlush(this._children[0]);
  } else {
    this.destroy();
  }
};
