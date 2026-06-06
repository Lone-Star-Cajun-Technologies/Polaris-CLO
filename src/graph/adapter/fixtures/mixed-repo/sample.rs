use std::fmt;

pub struct Worker;

pub enum Mode {
    DryRun,
}

pub trait Runner {
    fn run(&self) -> String;
}

pub fn build() -> Worker {
    Worker
}

impl Worker {
    pub fn run(&self) -> String {
        format!("{:?}", fmt::Error)
    }
}
