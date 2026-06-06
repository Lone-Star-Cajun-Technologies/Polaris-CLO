package sample

import (
  "fmt"
  "net/http"
)

type Worker struct{}

type Runner interface {
  Run() string
}

func Build() *Worker {
  return &Worker{}
}

func (w Worker) Run() string {
  return fmt.Sprintf("%T", http.MethodGet)
}
