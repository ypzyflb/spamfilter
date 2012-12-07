var async   = require('async');
var express = require('express');
var util    = require('util');
var natural = require ("natural");
var pg = require('pg');

// create an express webserver
var app = express.createServer(
  express.logger(),
  express.static(__dirname + '/public'),
  express.bodyParser(),
  express.cookieParser(),
  // set this to a secret value to encrypt session cookies
  express.session({ secret: process.env.SESSION_SECRET || 'secret123' }),
  require('faceplate').middleware({
    app_id: process.env.FACEBOOK_APP_ID,
    secret: process.env.FACEBOOK_SECRET,
    scope:  'user_likes,read_stream,publish_stream'
  })
);

// listen to the PORT given to us in the environment
var port = process.env.PORT || 3000;

app.listen(port, function() {
  console.log("Listening on " + port);
});

app.dynamicHelpers({
  'host': function(req, res) {
    return req.headers['host'];
  },
  'scheme': function(req, res) {
    req.headers['x-forwarded-proto'] || 'http'
  },
  'url': function(req, res) {
    return function(path) {
      return app.dynamicViewHelpers.scheme(req, res) + app.dynamicViewHelpers.url_no_scheme(path);
    }
  },
  'url_no_scheme': function(req, res) {
    return function(path) {
      return '://' + app.dynamicViewHelpers.host(req, res) + path;
    }
  }
});

function render_page(req, res) {
  req.facebook.app(function(app) {
    req.facebook.me(function(user) {
      res.render('index.ejs', {
        layout:    false,
        req:       req,
        app:       app,
        user:      user
      });
    });
  });
}

function handle_facebook_request(req, res) {

  // if the user is logged in
  if (req.facebook.token) {

    async.parallel([
      function(cb) {
        // query 4 friends and send them to the socket for this socket id
        req.facebook.get('/me/friends', { limit: 4 }, function(friends) {
          req.friends = friends;
          cb();
        });
      },
      function(cb) {
        // query 16 photos and send them to the socket for this socket id
        req.facebook.get('/me/photos', { limit: 16 }, function(photos) {
          req.photos = photos;
          cb();
        });
      },
      function(cb) {
        // query 4 likes and send them to the socket for this socket id
        req.facebook.get('/me/likes', { limit: 4 }, function(likes) {
          req.likes = likes;
          cb();
        });
      },
      function(cb) {
        // use fql to get a list of my friends that are using this app
        req.facebook.fql('SELECT uid, name, is_app_user, pic_square FROM user WHERE uid in (SELECT uid2 FROM friend WHERE uid1 = me()) AND is_app_user = 1', function(result) {
          req.friends_using_app = result;
          cb();
        });
      },
      function(cb) {
          req.facebook.get('/me/home', {limit: 20}, function (newsFeed) {
              newsFeed.forEach(function(news) {
                  news.clazz = Math.random() > 0.5 ? 'like' : 'dislike';
              });
              req.newsFeed = newsFeed;
              cb();
          });
      }
    ], function() {
      render_page(req, res);
    });

  } else {
    render_page(req, res);
  }
}

function get_classifier_for_user(uid) {
    var classifier_str;
    pg.connect(process.env.DATABASE_URL, function (err, client) {
        var query_str = 'SELECT classifier_string FROM classifiers where uid=cast(' + uid + ' as varchar(100))';
        console.log(query_str);
        var query = client.query(query_str);
        console.log(JSON.stringify(query));

        query.on('row', function (row) {
            classifier_str = row.classifier_string;
            console.log(classifier_str);
        });
        query.on('end', function() {
            if (!classifier_str) {
                console.log("no row received");
            }
        });
    });

    return classifier_str;
}

function insert_classifier_for_user(uid, c_str) {
    pg.connect(process.env.DATABASE_URL, function (err, client) {
        var query_str = 'INSERT INTO classifiers (uid, classifier_string) VALUES (' + uid + ', ' + c_str + ')';
        console.log(query_str);
    });
}
function handle_classifier_request(req, res) {
    var clazz = req.query['clazz'] || req.body.clazz;
    console.log("inside classifier clazz:" + clazz);
    var text = req.query['text'] || req.body.text;
    console.log("inside classifier text:" + text);
    var uid = req.query['uid'] || req.body.uid;
    console.log("inside classifier uid:" + uid);
    if (text && clazz && uid) {
        var classifier_str = get_classifier_for_user(uid);
        var classifier;
        var new_user;
        if (classifier_str) {
            new_user = false;
            classifier = natural.BayesClassifier.restore(JSON.parse(classifier_str));
        }
        else {
            new_user = true;
            classifier = new natural.BayesClassifier();
        }
        classifier.addDocument(text, clazz);
        classifier.train();
        console.log(JSON.stringify(classifier));

        if (new_user) {
            insert_classifier_for_user(uid, JSON.stringify(classifier));
        }
    }
    res.end("text = " + text);
}
app.get('/', handle_facebook_request);
app.post('/', handle_facebook_request);
app.get('/classify', handle_classifier_request);
app.post('/classify', handle_classifier_request);