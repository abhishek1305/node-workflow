// Copyright 2012 Pedro P. Candel <kusorbox@gmail.com>. All rights reserved.
var util = require('util'),
    events = require('events'),
    fork = require('child_process').fork,
    WorkflowTaskRunner = require('./task-runner');

// TODO:
// - We may want to save a timestamp with each task results.
//
// Run the given job. Optionally, can pass sandbox object for the 'task' VM
// and enable trace to retrieve task trace information.
// - opts (Object) with the following members:
//
// - runner (Object) insteance of the runner running this job. Required to
//   notify the runner about child processes spawned/finished. Required.
// - backend (Object) instance of the backend used. Required.
// - job (Object) the job to run. Required.
// - sandbox (Object) VM's sandbox for task (see WorkflowTaskRunner). Optional.
// - trace (Boolean) retrieve trace information from tasks. Optional.
var WorkflowJobRunner = module.exports = function(opts) {
  events.EventEmitter.call(this);
  if (typeof(opts) !== 'object') {
    throw new TypeError('opts (Object) required');
  }

  if (typeof(opts.runner) !== 'object') {
    throw new TypeError('opts.runner (Object) required');
  }

  if (typeof(opts.backend) !== 'object') {
    throw new TypeError('opts.backend (Object) required');
  }

  if (typeof(opts.job) !== 'object') {
    throw new TypeError('opts.job (Object) required');
  }

  if (opts.sandbox && typeof(opts.sandbox) !== 'object') {
    throw new TypeError('opts.sandbox must be an (Object)');
  }

  this.runner = opts.runner;
  this.job = opts.job;
  this.backend = opts.backend;
  this.sandbox = opts.sandbox || {};
  this.trace = opts.trace || false;

  if (!util.isDate(this.job.exec_after)) {
    this.job.exec_after = new Date(this.job.exec_after);
  }

  if (!this.job.chain) {
    this.job.chain = [];
  }

  if (!this.job.chain_results) {
    this.job.chain_results = [];
  }

  if (this.job.onerror && !this.job.onerror_results) {
    this.job.onerror_results = [];
  }
  // TODO:
  // Job may be re-queued, on such case we need to calculate the timeout
  // with this.job.timeout - this.job.elapsed
  this.timeout = (this.job.timeout) ? this.job.timeout * 1000 : null;

  // pointer to child process forked by runTask
  this.child = null;
};

util.inherits(WorkflowJobRunner, events.EventEmitter);

// Run the workflow within a timeout which, in turn, will call tasks in chain
// within their respective timeouts when given:
// PENDING:
// - Need to verify that exec_after is smaller than current time, otherwise the
//   job execution should be delayed.
// Arguments:
// - callback: f(err) - Used to send final job results
WorkflowJobRunner.prototype.run = function(callback) {
  var self = this;

  self.on('error', function(err, callback) {
    // We're already running the onerror chain, do not retry again!
    if (self.failed) {
      self.emit('end', err, callback);
    } else {
      self.failed = true;
      if (self.job.onerror && util.isArray(self.job.onerror)) {
        self.runChain(self.job.onerror, 'onerror_results', callback);
      } else {
        self.emit('end', err, callback);
      }
    }
  });

  self.on('end', function(err, callback) {
    if (err) {
      self.failure = err;
      self.job.execution = (err === 'queued') ? 'queued' : 'failed';
    } else {
      self.job.execution = 'succeeded';
    }
    return self.saveJob(callback);
  });

  self.runChain(self.job.chain, 'chain_results', callback);
};


// Run the given chain of tasks
// Arguments:
// - chain: the chain of tasks to run.
// - chain_results: the name of the job property to append current chain
//   results. For main `chain` it'll be `job.chain_results`; for `onerror`
//   branch, it'll be `onerror_results` and so far.
// - callback: f(err)
WorkflowJobRunner.prototype.runChain = function(chain, chain_results, callback) {
  var self = this,
  task, err,
  timeoutId = setTimeout(function() {
    // TODO: On job timeout, send child process kill signal.
    // Execution of everything timed out, have to abort running tasks and run
    // the onerror chain.
    clearTimeout(timeoutId);
    // May want to ignore tasks results once we timed out the whole workflow
    self.timedOut = true;
    // If it's already failed, what it's timing out is the 'onerror' chain.
    // We don't wanna run it again.
    if (!self.failed) {
      self.job[chain_results].push({
        error: 'workflow timeout',
        result: ''
      });
      self.backend.updateJobProperty(
        self.job.uuid,
        chain_results,
        self.job[chain_results],
        function(err) {
          self.emit('end', 'backend error', callback);
        });
      self.emit('error', 'workflow timeout', callback);
    } else {
      self.job.onerror_results.push({
        error: 'workflow timeout',
        result: ''
      });
      self.backend.updateJobProperty(
        self.job.uuid,
        chain_results,
        self.job.onerror_results,
        function(err) {
          self.emit('end', 'backend error', callback);
        });
      self.emit('end', 'workflow timeout', callback);
    }
  }, self.timeout),
  cb = function(error) {
    // Whatever happened here, we are timeout done.
    clearTimeout(timeoutId);
    if (error) {
      err = error;
      self.emit('error', error, callback);
    } else {
      // All tasks run successful. Need to report information so, we rather
      // emit 'end' and delegate into another function
      self.emit('end', null, callback);
    }
  };

  for (task = 0; task < chain.length; task += 1) {
    if (err) {
      break;
    }
    self.runTask(chain[task], chain_results, cb);
  }

};


WorkflowJobRunner.prototype.runTask = function(task, chain, cb) {
  var self = this;
  self.child = fork(__dirname + '/child.js');
  self.onChildUp();

  // Message may contain either only 'error' member, or also 'cmd',
  // 'result' and 'trace'.
  self.child.on('message', function(msg) {
    if (self.trace) {
      console.log('Got a message from child process:');
      console.log(util.inspect(msg, false, 8));
    }
    // Save the results into the result chain + update on the backend.
    var res = {
      result: msg.result,
      error: msg.error
    }
    if (self.trace && msg.trace) {
      res.trace = msg.trace;
    } 
    self.job[chain].push(res);
    self.backend.updateJobProperty(
      self.job.uuid,
      chain,
      self.job[chain],
      function(err) {
        // Backend error
        if (err) {
          return cb(err);
        }
        // Task error
        if (msg.error) {
          return cb(msg.error);
        }
        // All good:
        return cb(null);
      });
  });
  self.child.on('exit', function(code) {
    self.onChildExit();
  });

  self.child.send({
    task: task,
    job: self.job,
    sandbox: self.sandbox,
    trace: self.trace
  });
};

WorkflowJobRunner.prototype.onChildUp = function() {
  var self = this;
  self.child._pid = self.child.pid;
  self.runner.childUp(self.job.uuid, self.child._pid);
};

WorkflowJobRunner.prototype.onChildExit = function() {
  var self = this;
  self.runner.childDown(self.job.uuid, self.child._pid);
  self.child = null;
};

// - callback - f(err)
WorkflowJobRunner.prototype.saveJob = function(callback) {
  var self = this;
  // Decide what to do with the Job depending on its execution status:
  if (self.job.execution === 'failed' || self.job.execution === 'succeeded') {
    if (self.trace) {
      console.log('Finishing job ...');
    }
    self.backend.finishJob(self.job, function(err) {
      if (err) {
        return callback(err);
      }
      return callback(null);
    });
  } else if (self.job.execution === 'queued') {
    if (self.trace) {    
      console.log('Re queueing job ...');
    }
    self.backend.queueJob(self.job, function(err) {
      if (err) {
        return callback(err);
      }
      return callback();
    });
  } else {
    if (self.trace) {
      console.log('Unknown job execution status ' + self.job.execution);
    }
    return callback('unknown job execution status ' + self.job.execution);
  }
};
